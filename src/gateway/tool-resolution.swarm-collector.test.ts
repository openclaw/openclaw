import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useMcpCollectorRegistry } from "./mcp-http.collector-registry.test-support.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const runId = "cli-collector-run";
const schemalessRunId = "cli-schemaless-collector-run";
const collectorSessionKey = "agent:main:subagent:cli-collector";
const schemalessCollectorSessionKey = "agent:main:subagent:cli-schemaless-collector";
const plainSessionKey = "agent:main:subagent:cli-worker";
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const buildConfig = (tools?: OpenClawConfig["tools"]): OpenClawConfig =>
  ({
    plugins: { enabled: false },
    agents: { entries: { main: {} } },
    tools: { swarm: true, ...tools },
  }) as OpenClawConfig;

const admittedRunIdBySessionKey: Record<string, string> = {
  [collectorSessionKey]: runId,
  [schemalessCollectorSessionKey]: schemalessRunId,
  [plainSessionKey]: "cli-worker-run",
};

async function resolveTools(
  sessionKey: string,
  overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {},
) {
  const request = {
    cfg: buildConfig(),
    surface: "loopback" as const,
    runId: admittedRunIdBySessionKey[sessionKey],
    ...overrides,
    sessionKey,
  };
  setRuntimeConfigSnapshot(request.cfg);
  return (await resolveGatewayScopedTools(request)).tools;
}

async function resolveNames(...args: Parameters<typeof resolveTools>) {
  return (await resolveTools(...args)).map((tool) => tool.name);
}

async function updateCollector(
  update: (entry: SubagentRunRecord) => SubagentRunRecord,
  nextRunId = runId,
) {
  await mutateSubagentRuns(nextRunId === runId ? [runId] : [runId, nextRunId], (rows) => ({
    value: undefined,
    postimages: new Map<string, SubagentRunRecord | null>([
      [runId, null],
      [nextRunId, update(expectDefined(rows.get(runId), "collector run"))],
    ]),
  }));
}

useMcpCollectorRegistry({ runId, childSessionKey: collectorSessionKey, outputSchema: schema });

describe("resolveGatewayScopedTools swarm collectors", () => {
  it("keeps structured_output through a restrictive gateway tool policy", async () => {
    const names = await resolveNames(collectorSessionKey, {
      cfg: buildConfig({ allow: ["sessions_list"] }),
    });

    expect(names).toContain("sessions_list");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("sessions_search");
  });

  it("leaves non-collector sessions without the collector transport", async () => {
    const names = await resolveNames(plainSessionKey);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });

  it("stops serving the collector transport after the result is captured", async () => {
    await updateCollector((entry) => ({
      ...entry,
      collectorCompletion: { status: "done", structured: { answer: "ok" } },
    }));
    const names = await resolveNames(collectorSessionKey);

    expect(names).not.toContain("structured_output");
    expect(names).not.toContain("sessions_yield");
  });

  it("passes collector identity into tool construction for a schema-less collector", async () => {
    await addSubagentRunForTests({
      runId: schemalessRunId,
      childSessionKey: schemalessCollectorSessionKey,
      collect: true,
    });
    const tools = await resolveTools(schemalessCollectorSessionKey);
    const names = tools.map((tool) => tool.name);
    for (const forbidden of ["ask_user", "sessions_send", "sessions_yield", "structured_output"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain("sessions_list");
    const spawn = expectDefined(
      tools.find((tool) => tool.name === "sessions_spawn"),
      "collector sessions_spawn",
    );

    await expect(spawn.execute("nested", { task: "delegate" })).rejects.toThrow(
      "requires collect=true",
    );
  });
  it("withholds the contract from a run-bound grant for a different run", async () => {
    const names = await resolveNames(collectorSessionKey, { runId: "some-other-cli-run" });

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });

  it("admits the collector through the launch id a queued relaunch retains", async () => {
    // A relaunch retains the launch id as swarmRunId; both ids must admit the collector.
    const nextRunId = "cli-collector-relaunched";
    await updateCollector(
      (entry) => ({ ...entry, runId: nextRunId, swarmRunId: runId }),
      nextRunId,
    );

    for (const admittedRunId of [runId, "cli-collector-relaunched"]) {
      const names = await resolveNames(collectorSessionKey, { runId: admittedRunId });
      expect(names).toContain("structured_output");
    }
  });

  it("keeps operator tool policy authoritative for a collector session on the http surface", async () => {
    const names = await resolveNames(collectorSessionKey, {
      surface: "http",
      runId: undefined,
      senderIsOwner: true,
      allowGatewaySubagentBinding: true,
      cfg: buildConfig({ allow: ["sessions_list"] }),
    });

    expect(names).toEqual(["sessions_list"]);
  });
  it("rejects the result when the grant is revoked between construction and execute", async () => {
    // Cached tools must recheck revocation after the awaited before-tool hook.
    let grantCurrent = true;
    const tools = await resolveTools(collectorSessionKey, {
      isGrantCurrent: () => grantCurrent,
    });
    const structuredOutput = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector output transport",
    );
    expect(structuredOutput.catalogMode).toBe("direct-only");

    grantCurrent = false;

    await expect(
      structuredOutput.execute("revoked-collector-result", {
        result: { answer: "ok" },
      }),
    ).rejects.toThrow("collector run grant is no longer active");
    expect(getSubagentRunByRunId(runId)?.structuredOutput).toBeUndefined();
    expect(getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
  });
  it("hard-filters structured_output out of a grant that never merged it", async () => {
    const cfg = buildConfig();
    setRuntimeConfigSnapshot(cfg);
    const { tools } = await resolveMcpLoopbackScopedTools({
      cfg,
      context: {
        sessionKey: collectorSessionKey,
        senderIsOwner: false,
        toolsAllow: ["read"],
        runId,
      },
    });
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual(["read"]);
  });
});
