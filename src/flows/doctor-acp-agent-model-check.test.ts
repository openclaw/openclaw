// Registered Doctor diagnostics explain ACP/native model selection without proposing repairs.
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
const ACP_RUNTIME = {
  type: "acp",
  acp: { agent: "cursor", backend: "acpx" },
} satisfies AgentEntry["runtime"];
const NATIVE_MODEL = "anthropic/claude-sonnet-4-6";
const HARNESS_MODEL = "harness-only[context=272k,reasoning=medium,fast=false]";

async function detect(cfg: OpenClawConfigWithLegacyRoster) {
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
    { primary: NATIVE_MODEL, objectForm: false, legacy: false, unsafe: false },
    { primary: HARNESS_MODEL, objectForm: true, legacy: false, unsafe: false },
    { primary: HARNESS_MODEL, objectForm: false, legacy: true, unsafe: false },
    { primary: HARNESS_MODEL, objectForm: true, legacy: true, unsafe: false },
    {
      primary: "harness\u001b[31m\nmodel\r\t\u0007",
      objectForm: false,
      legacy: false,
      unsafe: true,
    },
  ])(
    "reports a harness model without repair (legacy=$legacy, object=$objectForm, unsafe=$unsafe)",
    async ({ primary, objectForm, legacy, unsafe }) => {
      const id = unsafe ? "cursor.ops\u001b[31m\nagent" : "cursoragent";
      const agent = { runtime: ACP_RUNTIME, model: objectForm ? { primary } : primary };
      const findings = await detect({
        agents: {
          defaults: { model: unsafe ? "anthropic/native\u001b[31m\nmodel" : NATIVE_MODEL },
          ...(legacy ? { list: [{ id: "main" }, { id, ...agent }] } : { entries: { [id]: agent } }),
        },
      });
      expect(findings).toEqual([
        {
          checkId: "core/doctor/acp-agent-model",
          severity: "info",
          source: "doctor",
          target: unsafe ? "cursor.ops\\nagent" : id,
          path: unsafe
            ? 'agents.entries["cursor.ops\\u001b[31m\\nagent"].model'
            : `${legacy ? "agents.list[1]" : "agents.entries.cursoragent"}.model${objectForm ? ".primary" : ""}`,
          message: expect.any(String),
        },
      ]);
      expect(findings[0]?.message).toContain(
        `ACP harness model "${unsafe ? "harness\\nmodel\\r\\t" : primary}"`,
      );
      expect(findings[0]?.message).toContain(
        `native default is "${unsafe ? "anthropic/native\\nmodel" : NATIVE_MODEL}"`,
      );
      expect(findings[0]?.message).toContain(
        "Explicit native session, utility, and subagent model selections still apply.",
      );
      expect(
        findings.map((finding) => `${finding.target}${finding.path}${finding.message}`).join(""),
      ).not.toMatch(/\p{Cc}/u);
    },
  );

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
});
