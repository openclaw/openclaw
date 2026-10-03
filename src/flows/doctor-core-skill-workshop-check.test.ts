import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function getSkillWorkshopCheck(): HealthCheck {
  const check = createCoreHealthChecks().find(
    (candidate) => candidate.id === "core/doctor/skill-workshop-tool-policy",
  );
  if (!check || !("detect" in check)) {
    throw new Error("missing Skill Workshop health check");
  }
  return check;
}

describe("core/doctor/skill-workshop-tool-policy", () => {
  it("warns when autonomous capture is enabled but policy hides its tool", async () => {
    const findings = await getSkillWorkshopCheck().detect({
      mode: "doctor",
      runtime,
      cfg: {
        skills: { workshop: { autonomous: { mode: "propose" } } },
        tools: { profile: "messaging" },
      },
    });

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
    const cfg: OpenClawConfig = {
      skills: { workshop: { autonomous: { mode: "propose" } } },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { tools: { profile: "coding" } },
          helper: { tools: { profile: "messaging" } },
          third: { tools: { profile: "coding" } },
        },
      },
    };

    const result = await runDoctorLintChecks(
      { mode: "lint", runtime, cfg },
      { checks: [getSkillWorkshopCheck()] },
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        target: "helper",
        path: "agents.entries.helper.tools.profile",
      }),
    ]);
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("health check threw") }),
    );
  });

  it.each([
    {
      label: "sole-agent roster",
      cfg: {
        agents: { entries: { solo: { tools: { profile: "messaging" } } } },
      } satisfies OpenClawConfig,
      target: "solo",
    },
    {
      label: "legacy-default roster",
      cfg: {
        agents: {
          list: [
            { id: "owner", default: true, tools: { profile: "messaging" } },
            { id: "helper", tools: { profile: "coding" } },
          ],
        },
      } satisfies OpenClawConfig,
      target: "owner",
    },
  ])("preserves normal diagnostics for a $label", async ({ cfg, target }) => {
    const findings = await getSkillWorkshopCheck().detect({
      mode: "doctor",
      runtime,
      cfg: {
        ...cfg,
        skills: { workshop: { autonomous: { mode: "propose" } } },
      },
    });

    expect(findings).toEqual([expect.objectContaining({ severity: "warning", target })]);
  });

  it("does not warn when autonomous capture is disabled", async () => {
    await expect(
      getSkillWorkshopCheck().detect({
        mode: "doctor",
        runtime,
        cfg: {
          skills: { workshop: { autonomous: { mode: "off" } } },
          tools: { profile: "messaging" },
        },
      }),
    ).resolves.toEqual([]);
  });

  it.each([undefined, "off"] as const)(
    "reports CLI review inactivity per agent without replacing sandbox findings (mode=%s)",
    async (mode) => {
      const registry = createEmptyPluginRegistry();
      registry.cliBackends.push({
        pluginId: "fixture-provider",
        source: "runtime",
        backend: {
          id: "fixture-cli",
          modelProvider: "fixture-provider",
          config: { command: "fixture-cli" },
        },
      });
      const cfg: OpenClawConfig = {
        ...(mode ? { skills: { workshop: { autonomous: { mode } } } } : {}),
        agents: {
          ownership: "explicit",
          entries: {
            direct: { model: { primary: "fixture-cli/fixture-model" } },
            canonical: {
              model: { primary: "fixture-provider/fixture-model" },
              models: {
                "fixture-provider/fixture-model": { agentRuntime: { id: "fixture-cli" } },
              },
            },
            sandboxed: {
              model: { primary: "fixture-cli/fixture-model" },
              sandbox: { mode: "all" },
            },
            native: { model: { primary: "fixture-provider/fixture-model" } },
            codex: {
              model: { primary: "openai/fixture-model" },
              models: { "openai/fixture-model": { agentRuntime: { id: "codex" } } },
            },
          },
        },
        tools: { profile: "coding" },
      };
      const result = await withPluginRuntimeRegistryScope(registry, () =>
        runDoctorLintChecks({ mode: "lint", runtime, cfg }, { checks: [getSkillWorkshopCheck()] }),
      );
      if (mode === "off") {
        expect(result.findings).toEqual([]);
        return;
      }
      const inactive = result.findings.filter((finding) =>
        finding.message.includes("delayed experience review is unavailable"),
      );
      expect(inactive).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "warning", target: "direct" }),
          expect.objectContaining({ severity: "warning", target: "canonical" }),
          expect.objectContaining({ severity: "warning", target: "sandboxed" }),
        ]),
      );
      expect(inactive).toHaveLength(3);
      expect(inactive.every((finding) => finding.message.includes("fixture-cli"))).toBe(true);
      expect(result.findings).toHaveLength(4);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          target: "sandboxed",
          path: "agents.entries.sandboxed.sandbox.mode",
        }),
      );
    },
  );
});
