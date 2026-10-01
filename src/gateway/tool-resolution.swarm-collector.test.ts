import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "../agents/tools/structured-output-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

vi.mock("../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/subagents/registry/subagent-registry-state.js")
  >()),
  persistSubagentRunsToDiskOrThrow: () => {},
}));

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
    agents: { entries: { main: { default: true } } },
    tools: { swarm: true, ...tools },
  } as OpenClawConfig;
}

const admittedRunIdBySessionKey: Record<string, string> = {
  [collectorSessionKey]: runId,
  [schemalessCollectorSessionKey]: schemalessRunId,
  [plainSessionKey]: "cli-worker-run",
};

function resolveLoopbackTools(
  sessionKey: string,
  options?: {
    tools?: OpenClawConfig["tools"];
    admittedRunId?: string;
    isGrantCurrent?: () => boolean;
  },
) {
  return resolveGatewayScopedTools({
    cfg: buildConfig(options?.tools),
    sessionKey,
    surface: "loopback",
    runId: options?.admittedRunId ?? admittedRunIdBySessionKey[sessionKey],
    isGrantCurrent: options?.isGrantCurrent,
  }).tools;
}

function resolveHttpToolNames(sessionKey: string, tools?: OpenClawConfig["tools"]) {
  return resolveGatewayScopedTools({
    cfg: buildConfig(tools),
    sessionKey,
    senderIsOwner: true,
    allowGatewaySubagentBinding: true,
    surface: "http",
  }).tools.map((tool) => tool.name);
}

function resolveLoopbackGrantToolNames(toolsAllow: string[]) {
  return resolveMcpLoopbackScopedTools({
    cfg: buildConfig(),
    context: {
      sessionKey: collectorSessionKey,
      senderIsOwner: false,
      toolsAllow,
      runId,
    },
  }).then((scoped) => scoped.tools.map((tool) => (tool as { name: string }).name));
}

beforeEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  addSubagentRunForTests({
    runId,
    childSessionKey: collectorSessionKey,
    collect: true,
    outputSchema: schema,
  });
  addSubagentRunForTests({
    runId: schemalessRunId,
    childSessionKey: schemalessCollectorSessionKey,
    collect: true,
  });
});

afterEach(() => {
  consumeSwarmStructuredOutput(runId);
  resetSubagentRegistryForTests({ persist: false });
});

describe("resolveGatewayScopedTools swarm collectors", () => {
  it("serves structured_output to a collector child resolved through the gateway", async () => {
    const tools = resolveLoopbackTools(collectorSessionKey, { isGrantCurrent: () => true });

    const structuredOutput = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector output transport",
    );
    expect(structuredOutput.catalogMode).toBe("direct-only");
    const result = await structuredOutput.execute("gateway-collector-result", {
      result: { answer: "ok" },
    });
    expect(result.details).toEqual({ status: "recorded" });
    expect(getSubagentRunByRunId(runId)?.structuredOutput).toEqual({
      structured: { answer: "ok" },
      invalidAttempts: 0,
    });
  });

  it("keeps structured_output through a restrictive gateway tool policy", () => {
    const names = resolveLoopbackTools(collectorSessionKey, {
      tools: { allow: ["sessions_list"] },
    }).map((tool) => tool.name);

    expect(names).toContain("sessions_list");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("sessions_search");
  });

  it("omits interactive and pausing tools for a gateway collector child", () => {
    const collectorNames = resolveLoopbackTools(collectorSessionKey).map((tool) => tool.name);
    const plainNames = resolveLoopbackTools(plainSessionKey).map((tool) => tool.name);

    for (const forbidden of ["ask_user", "sessions_send", "sessions_yield"]) {
      expect(collectorNames).not.toContain(forbidden);
    }
    expect(plainNames).toContain("sessions_yield");
  });

  it("leaves non-collector sessions without the collector transport", () => {
    const names = resolveLoopbackTools(plainSessionKey).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });

  it("stops serving the collector transport after the result is captured", () => {
    const entry = expectDefined(getSubagentRunByRunId(runId), "collector run");
    entry.collectorCompletion = { status: "done", structured: { answer: "ok" } };

    const names = resolveLoopbackTools(collectorSessionKey).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    // Collector identity outlives the captured result, as it does on the embedded
    // path where `swarmCollector` comes from the spawn request and is never cleared.
    expect(names).not.toContain("sessions_yield");
  });

  it("withholds requester-only tools from a collector child that requested no schema", () => {
    const names = resolveLoopbackTools(schemalessCollectorSessionKey).map((tool) => tool.name);

    // A schema-less collector is still collected by an explicit wait, so it has no
    // requester continuation to yield into and no interactive surface to ask on.
    for (const forbidden of ["ask_user", "sessions_send", "sessions_yield"]) {
      expect(names).not.toContain(forbidden);
    }
    // Its result tool stays absent: there is no schema to validate a result against.
    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_list");
  });

  it("passes collector identity into tool construction for a schema-less collector", async () => {
    const spawn = expectDefined(
      resolveLoopbackTools(schemalessCollectorSessionKey).find(
        (tool) => tool.name === "sessions_spawn",
      ),
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
  it("withholds the contract from a run-bound grant for a different run", () => {
    const names = resolveLoopbackTools(collectorSessionKey, {
      admittedRunId: "some-other-cli-run",
    }).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });

  it("admits the collector through the launch id a queued relaunch retains", () => {
    // A relaunch moves `runId` to the new Gateway run and keeps the original as
    // `swarmRunId`; `getSubagentRunByRunId` answers to both, so the gate does too.
    const entry = expectDefined(getSubagentRunByRunId(runId), "collector run");
    entry.swarmRunId = runId;
    entry.runId = "cli-collector-relaunched";

    for (const admittedRunId of [runId, "cli-collector-relaunched"]) {
      const names = resolveLoopbackTools(collectorSessionKey, {
        admittedRunId,
      }).map((tool) => tool.name);
      expect(names).toContain("structured_output");
    }
  });

  it("leaves the http surface exactly as it is without a collector session", () => {
    const collectorNames = resolveHttpToolNames(collectorSessionKey);
    const plainNames = resolveHttpToolNames(plainSessionKey);

    expect(collectorNames).not.toContain("structured_output");
    expect(collectorNames).toContain("sessions_yield");
    expect(collectorNames).toEqual(plainNames);
  });

  it("keeps operator tool policy authoritative for a collector session on the http surface", () => {
    const names = resolveHttpToolNames(collectorSessionKey, {
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
    const tools = resolveLoopbackTools(collectorSessionKey, {
      isGrantCurrent: () => grantCurrent,
    });
    const structuredOutput = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector output transport",
    );

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
  it("serves structured_output when the CLI grant carries the merged collector allowlist", async () => {
    const names = await resolveLoopbackGrantToolNames(["read", "structured_output"]);

    expect(names).toContain("structured_output");
    expect(names).toContain("read");
  });

  it("hard-filters structured_output out of a grant that never merged it", async () => {
    const names = await resolveLoopbackGrantToolNames(["read"]);

    expect(names).toEqual(["read"]);
  });
});
