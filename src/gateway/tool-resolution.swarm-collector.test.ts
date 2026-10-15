import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
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

function buildConfig(tools?: OpenClawConfig["tools"]): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: { entries: { main: {} } },
    tools: { swarm: true, ...tools },
  } as OpenClawConfig;
}

/** Run id a run-bound CLI grant carries for each child session under test. */
const admittedRunIdBySessionKey: Record<string, string> = {
  [collectorSessionKey]: runId,
  [schemalessCollectorSessionKey]: schemalessRunId,
  [plainSessionKey]: "cli-worker-run",
};

/**
 * A loopback request from a Gateway-launched CLI child. `admittedRunId: null`
 * models the session-scoped `openclaw attach` client, whose request context
 * carries no run id at all.
 */
async function resolveLoopbackTools(
  sessionKey: string,
  options?: {
    tools?: OpenClawConfig["tools"];
    admittedRunId?: string | null;
    isGrantCurrent?: () => boolean;
  },
) {
  const cfg = buildConfig(options?.tools);
  setRuntimeConfigSnapshot(cfg);
  const admittedRunId =
    options?.admittedRunId === undefined
      ? admittedRunIdBySessionKey[sessionKey]
      : (options.admittedRunId ?? undefined);
  return (
    await resolveGatewayScopedTools({
      cfg,
      sessionKey,
      surface: "loopback",
      runId: admittedRunId,
      isGrantCurrent: options?.isGrantCurrent,
    })
  ).tools;
}

/** Mirrors the only non-loopback caller, `tools-invoke-shared.ts`. */
async function resolveHttpToolNames(sessionKey: string, tools?: OpenClawConfig["tools"]) {
  const cfg = buildConfig(tools);
  setRuntimeConfigSnapshot(cfg);
  return (
    await resolveGatewayScopedTools({
      cfg,
      sessionKey,
      senderIsOwner: true,
      allowGatewaySubagentBinding: true,
      surface: "http",
    })
  ).tools.map((tool) => tool.name);
}

function resolveLoopbackGrantToolNames(toolsAllow: string[]) {
  const cfg = buildConfig();
  setRuntimeConfigSnapshot(cfg);
  return resolveMcpLoopbackScopedTools({
    cfg,
    context: {
      sessionKey: collectorSessionKey,
      senderIsOwner: false,
      toolsAllow,
      runId,
    },
  }).then((scoped) => scoped.tools.map((tool) => (tool as { name: string }).name));
}

beforeEach(() => setRuntimeConfigSnapshot(buildConfig()));
useMcpCollectorRegistry({ runId, childSessionKey: collectorSessionKey, outputSchema: schema });

beforeEach(async () => {
  await addSubagentRunForTests({
    runId: schemalessRunId,
    childSessionKey: schemalessCollectorSessionKey,
    collect: true,
  });
});

describe("resolveGatewayScopedTools swarm collectors", () => {
  it("keeps structured_output through a restrictive gateway tool policy", async () => {
    const names = (
      await resolveLoopbackTools(collectorSessionKey, {
        tools: { allow: ["sessions_list"] },
      })
    ).map((tool) => tool.name);

    expect(names).toContain("sessions_list");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("sessions_search");
  });

  it("leaves non-collector sessions without the collector transport", async () => {
    const names = (await resolveLoopbackTools(plainSessionKey)).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });

  it("stops serving the collector transport after the result is captured", async () => {
    await mutateSubagentRuns([runId], (rows) => {
      const entry = expectDefined(rows.get(runId), "collector run");
      return {
        value: undefined,
        postimages: new Map<string, SubagentRunRecord>([
          [
            runId,
            {
              ...entry,
              collectorCompletion: { status: "done", structured: { answer: "ok" } },
            },
          ],
        ]),
      };
    });

    const names = (await resolveLoopbackTools(collectorSessionKey)).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    // Collector identity outlives the captured result, as it does on the embedded
    // path where `swarmCollector` comes from the spawn request and is never cleared.
    expect(names).not.toContain("sessions_yield");
  });

  it("passes collector identity into tool construction for a schema-less collector", async () => {
    const tools = await resolveLoopbackTools(schemalessCollectorSessionKey);
    const names = tools.map((tool) => tool.name);
    for (const forbidden of ["ask_user", "sessions_send", "sessions_yield", "structured_output"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain("sessions_list");
    const spawn = expectDefined(
      tools.find((tool) => tool.name === "sessions_spawn"),
      "collector sessions_spawn",
    );

    // The nested-spawn guard reads the same `swarmCollector` option branch B's
    // yield admission check reads, so this pins the flag reaching createOpenClawTools.
    await expect(spawn.execute("nested", { task: "delegate" })).rejects.toThrow(
      "requires collect=true",
    );
  });
});

describe("collector contract is bound to the admitted collector run", () => {
  it("withholds the contract from a run-bound grant for a different run", async () => {
    const names = (
      await resolveLoopbackTools(collectorSessionKey, {
        admittedRunId: "some-other-cli-run",
      })
    ).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });

  it("admits the collector through the launch id a queued relaunch retains", async () => {
    // A relaunch moves `runId` to the new Gateway run and keeps the original as
    // `swarmRunId`; `getSubagentRunByRunId` answers to both, so the gate does too.
    const nextRunId = "cli-collector-relaunched";
    await mutateSubagentRuns([runId, nextRunId], (rows) => {
      const entry = expectDefined(rows.get(runId), "collector run");
      return {
        value: undefined,
        postimages: new Map<string, SubagentRunRecord | null>([
          [runId, null],
          [nextRunId, { ...entry, runId: nextRunId, swarmRunId: runId }],
        ]),
      };
    });

    for (const admittedRunId of [runId, "cli-collector-relaunched"]) {
      const names = (
        await resolveLoopbackTools(collectorSessionKey, {
          admittedRunId,
        })
      ).map((tool) => tool.name);
      expect(names).toContain("structured_output");
    }
  });

  it("keeps operator tool policy authoritative for a collector session on the http surface", async () => {
    const names = await resolveHttpToolNames(collectorSessionKey, {
      allow: ["sessions_list"],
    });

    expect(names).toEqual(["sessions_list"]);
  });
});

describe("collector write authority is re-checked before persistence", () => {
  it("rejects the result when the grant is revoked between construction and execute", async () => {
    // The before-tool hook is awaited between tool construction and execute, and
    // the tool list is cached per grant, so revocation has to be re-read at the
    // write itself rather than trusted from resolve time.
    let grantCurrent = true;
    const tools = await resolveLoopbackTools(collectorSessionKey, {
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
});

describe("collector tools behind the loopback grant allowlist", () => {
  it("hard-filters structured_output out of a grant that never merged it", async () => {
    const names = await resolveLoopbackGrantToolNames(["read"]);

    expect(names).toEqual(["read"]);
  });
});
