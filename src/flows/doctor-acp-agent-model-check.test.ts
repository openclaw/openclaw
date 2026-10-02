// Registered Doctor diagnostics explain ACP/native model selection without proposing repairs.
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
const ACP_RUNTIME = {
  type: "acp",
  acp: { agent: "cursor", backend: "acpx" },
} satisfies AgentEntry["runtime"];
const NATIVE_MODEL = "anthropic/claude-sonnet-4-6";
const HARNESS_MODEL = "harness-only[context=272k,reasoning=medium,fast=false]";

async function detect(cfg: OpenClawConfig) {
  const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/acp-agent-model");
  if (!check) {
    throw new Error("missing registered ACP agent model check");
  }
  expect(typeof check.repair).toBe("undefined");
  const before = structuredClone(cfg);
  const findings = await check.detect({ mode: "lint", runtime: createTestRuntime(), cfg });
  expect(cfg).toEqual(before);
  return findings;
}

describe("core/doctor/acp-agent-model", () => {
  it.each([
    { primary: NATIVE_MODEL, objectForm: false },
    { primary: "openai/gpt-5.4", objectForm: true },
    { primary: HARNESS_MODEL, objectForm: true },
  ])("reports $primary as information without changing config", async ({ primary, objectForm }) => {
    const findings = await detect({
      agents: {
        defaults: { model: NATIVE_MODEL },
        entries: {
          cursoragent: { runtime: ACP_RUNTIME, model: objectForm ? { primary } : primary },
        },
      },
    });

    expect(findings).toEqual([
      {
        checkId: "core/doctor/acp-agent-model",
        severity: "info",
        source: "doctor",
        target: "cursoragent",
        path: `agents.entries.cursoragent.model${objectForm ? ".primary" : ""}`,
        message: expect.any(String),
      },
    ]);
    expect(findings[0]?.message).toContain(`ACP harness model "${primary}"`);
    expect(findings[0]?.message).toContain(`native default is "${NATIVE_MODEL}"`);
    expect(findings[0]?.message).toContain(
      "Explicit native session, utility, and subagent model selections still apply.",
    );
  });

  it.each([false, true])("uses the legacy roster index for object form %s", async (objectForm) => {
    const findings = await detect({
      agents: {
        defaults: { model: NATIVE_MODEL },
        list: [
          { id: "main" },
          {
            id: "cursoragent",
            runtime: ACP_RUNTIME,
            model: objectForm ? { primary: HARNESS_MODEL } : HARNESS_MODEL,
          },
        ],
      },
    });
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "info",
        path: `agents.list[1].model${objectForm ? ".primary" : ""}`,
      }),
    ]);
  });

  it("ignores native agents and ACP agents without a configured primary", async () => {
    expect(
      await detect({
        agents: {
          defaults: { model: NATIVE_MODEL },
          entries: {
            ordinary: { model: "openai/gpt-5.4" },
            embedded: { runtime: { type: "embedded" }, model: "openai/gpt-5.4" },
            cursoragent: { runtime: ACP_RUNTIME },
          },
        },
      }),
    ).toEqual([]);
  });

  it("quotes config keys and renders untrusted identifiers and references safely", async () => {
    const findings = await detect({
      agents: {
        defaults: { model: "anthropic/native\u001b[31m\nmodel" },
        entries: {
          "cursor.ops\u001b[31m\nagent": {
            runtime: ACP_RUNTIME,
            model: "harness\u001b[31m\nmodel\r\t\u0007",
          },
        },
      },
    });
    expect(findings).toEqual([
      expect.objectContaining({
        target: "cursor.ops\\nagent",
        path: 'agents.entries["cursor.ops\\u001b[31m\\nagent"].model',
      }),
    ]);
    expect(findings[0]?.message).toContain('ACP harness model "harness\\nmodel\\r\\t"');
    expect(findings[0]?.message).toContain('native default is "anthropic/native\\nmodel"');
    expect(
      findings.map((finding) => `${finding.target}${finding.path}${finding.message}`).join(""),
    ).not.toMatch(/\p{Cc}/u);
  });
});
