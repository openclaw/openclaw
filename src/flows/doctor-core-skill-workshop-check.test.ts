import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";

const runtime = { log() {}, error() {}, exit() {} };
const check = createCoreHealthChecks().find(
  (entry) => entry.id === "core/doctor/skill-workshop-tool-policy",
)!;
const workshop = (mode: "auto" | "off" = "auto") => ({ autonomous: { mode } });
const context = (cfg: OpenClawConfig, mode: "doctor" | "lint" = "doctor") => ({
  mode,
  runtime,
  cfg: { skills: { workshop: workshop() }, ...cfg },
});
const lint = (cfg: OpenClawConfig) =>
  runDoctorLintChecks(context(cfg, "lint"), { checks: [check] });
const detect = (cfg: OpenClawConfig) => check.detect(context(cfg));

describe("core/doctor/skill-workshop-tool-policy", () => {
  it.each([true, false])("respects a reader's Workshop opt-out (deny=%s)", async (denied) => {
    const result = await lint({
      agents: {
        entries: {
          reader: {
            tools: { profile: "minimal", ...(denied ? { deny: ["group:agents"] } : {}) },
          },
        },
      },
    });

    expect(result.findings).toEqual(
      denied
        ? []
        : [
            expect.objectContaining({
              severity: "warning",
              target: "reader",
              path: "agents.entries.reader.tools.profile",
              fixHint: 'Add agents.entries.reader.tools.alsoAllow: ["skill_workshop"].',
            }),
          ],
    );
  });

  it("warns when autonomous capture is enabled but policy hides its tool", async () => {
    const findings = await detect({ tools: { profile: "messaging" } });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: 'tools.profile: "messaging" does not include "skill_workshop".',
        path: "tools.profile",
        fixHint: 'Add tools.alsoAllow: ["skill_workshop"].',
      }),
    ]);
  });

  it("checks every explicit-roster agent without turning selection into a health error", async () => {
    const result = await lint({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { tools: { profile: "coding" } },
          helper: { tools: { profile: "messaging" } },
          third: { tools: { profile: "coding" } },
        },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        target: "helper",
        path: "agents.entries.helper.tools.profile",
      }),
    ]);
  });

  it.each([
    {
      cfg: {
        agents: { entries: { solo: { tools: { profile: "messaging" } } } },
      } satisfies OpenClawConfig,
      target: "solo",
    },
    {
      cfg: createCanonicalAgentConfigFixture({
        agents: {
          list: [
            { id: "owner", default: true, tools: { profile: "messaging" } },
            { id: "helper", tools: { profile: "coding" } },
          ],
        },
      }).config,
      target: "owner",
    },
  ])("preserves normal diagnostics for roster target $target", async ({ cfg, target }) => {
    const findings = await detect(cfg);

    expect(findings).toEqual([expect.objectContaining({ severity: "warning", target })]);
  });

  it("does not warn when autonomous capture is disabled", async () => {
    await expect(
      detect({ skills: { workshop: workshop("off") }, tools: { profile: "messaging" } }),
    ).resolves.toEqual([]);
  });

  it.each([
    { pin: "anthropic:claude-cli", order: ["anthropic:api", "anthropic:claude-cli"], warns: true },
    { pin: "anthropic:api", order: ["anthropic:claude-cli", "anthropic:api"], warns: false },
  ])("follows the configured auth-profile pin to the runtime (pin=$pin)", async (testCase) => {
    const cfg = {
      skills: { workshop: { autonomous: { mode: "auto" } } },
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
        order: { anthropic: testCase.order },
      },
      agents: {
        ownership: "explicit",
        entries: { main: { model: { primary: `anthropic/claude-sonnet-5@${testCase.pin}` } } },
      },
    } as OpenClawConfig;

    const findings = await detect(cfg);

    expect(findings).toEqual(
      testCase.warns
        ? [
            expect.objectContaining({
              target: "main",
              path: "agents.entries.main.model",
              message: expect.stringContaining('CLI runtime "claude-cli"'),
            }),
          ]
        : [],
    );
  });

  it.each(["skill_workshop", "group:agents"])(
    "skips the runtime warning for a CLI agent that denies %s",
    async (deny) => {
      const result = await lint({
        agents: {
          ownership: "explicit",
          entries: {
            "opted-out": {
              model: { primary: "claude-cli/claude-sonnet-5" },
              tools: { deny: [deny] },
            },
            control: { model: { primary: "claude-cli/claude-sonnet-5" } },
          },
        },
      });

      expect(result.findings).toEqual([
        expect.objectContaining({
          target: "control",
          path: "agents.entries.control.model",
          message: expect.stringContaining('CLI runtime "claude-cli"'),
        }),
      ]);
    },
  );
});
