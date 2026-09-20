// Doctor must make the ACP harness/OpenClaw model split discoverable, loudly for configs it changes.
// Driven through the registered check so the wiring stays covered, not just the helper.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createAcpAgentModelCheck } from "./doctor-acp-agent-model-check.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

const ACP_RUNTIME = { type: "acp", acp: { agent: "cursor", backend: "acpx" } };

async function detect(cfg: OpenClawConfig): Promise<readonly HealthFinding[]> {
  return await createAcpAgentModelCheck().detect({
    mode: "lint",
    cfg,
    cwd: process.cwd(),
  } as unknown as HealthCheckContext);
}

function buildConfig(entry: Record<string, unknown>): OpenClawConfig {
  return {
    agents: {
      defaults: { model: "anthropic/claude-opus-5" },
      entries: { cursoragent: { id: "cursoragent", ...entry } },
    },
  } as unknown as OpenClawConfig;
}

describe("core/doctor/acp-agent-model", () => {
  it("warns when an ACP agent's primary was a dispatchable reference", async () => {
    const findings = await detect(
      buildConfig({ runtime: ACP_RUNTIME, model: { primary: "openai/gpt-5.4" } }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.path).toBe("agents.entries.cursoragent.model.primary");
    expect(findings[0]?.message).toContain("openai/gpt-5.4");
    expect(findings[0]?.message).toContain("anthropic/claude-opus-5");
    expect(findings[0]?.fixHint).toContain("agents.defaults.model");
  });

  it("reports a harness-only model id as information, not a warning", async () => {
    const findings = await detect(
      buildConfig({
        runtime: ACP_RUNTIME,
        model: { primary: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]" },
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.message).toContain("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]");
    expect(findings[0]?.message).toContain("anthropic/claude-opus-5");
  });

  it("skips a legacy roster entry that has no id yet", async () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-5" },
        list: [{ runtime: ACP_RUNTIME, model: { primary: "openai/gpt-5.4" } }],
      },
    } as unknown as OpenClawConfig;

    expect(await detect(cfg)).toEqual([]);
  });

  it("ignores embedded agents and ACP agents without a configured primary", async () => {
    expect(await detect(buildConfig({ model: { primary: "openai/gpt-5.4" } }))).toEqual([]);
    expect(await detect(buildConfig({ runtime: ACP_RUNTIME }))).toEqual([]);
  });
});
