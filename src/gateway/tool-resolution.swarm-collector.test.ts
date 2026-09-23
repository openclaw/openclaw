/**
 * CLI-backed Swarm collector children resolve their tools through the Gateway
 * MCP surface instead of the embedded runner, so the collector run contract has
 * to hold on this path too. The second describe pins the contract to the
 * admitted collector run's own grant, so a session-scoped `openclaw attach`
 * client on the same loopback server and a different run's grant both get the
 * plain surface, and the operator-facing `http` surface stays on main's
 * behavior. The third covers the write-time authority re-check, and the fourth
 * covers the layer above the resolver, where the minted grant allowlist is
 * enforced exactly.
 */
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
const unregisteredCollectorSessionKey = "agent:main:subagent:cli-collector-restarted";
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

/** Run id a run-bound CLI grant carries for each child session under test. */
const admittedRunIdBySessionKey: Record<string, string> = {
  [collectorSessionKey]: runId,
  [schemalessCollectorSessionKey]: schemalessRunId,
  [plainSessionKey]: "cli-worker-run",
  [unregisteredCollectorSessionKey]: "cli-collector-restarted-run",
};

/**
 * A loopback request from a Gateway-launched CLI child. `admittedRunId: null`
 * models the session-scoped `openclaw attach` client, whose request context
 * carries no run id at all.
 */
function resolveLoopbackTools(
  sessionKey: string,
  options?: {
    tools?: OpenClawConfig["tools"];
    admittedRunId?: string | null;
    isGrantCurrent?: () => boolean;
  },
) {
  const admittedRunId =
    options?.admittedRunId === undefined
      ? admittedRunIdBySessionKey[sessionKey]
      : (options.admittedRunId ?? undefined);
  return resolveGatewayScopedTools({
    cfg: buildConfig(options?.tools),
    sessionKey,
    surface: "loopback",
    runId: admittedRunId,
    isGrantCurrent: options?.isGrantCurrent,
  }).tools;
}

/** Mirrors the only non-loopback caller, `tools-invoke-shared.ts`. */
function resolveHttpToolNames(sessionKey: string, tools?: OpenClawConfig["tools"]) {
  return resolveGatewayScopedTools({
    cfg: buildConfig(tools),
    sessionKey,
    senderIsOwner: true,
    allowGatewaySubagentBinding: true,
    surface: "http",
  }).tools.map((tool) => tool.name);
}

function resolveLoopbackGrantToolNames(toolsAllow: string[], admittedRunId: string | null = runId) {
  return resolveMcpLoopbackScopedTools({
    cfg: buildConfig(),
    context: {
      sessionKey: collectorSessionKey,
      senderIsOwner: false,
      toolsAllow,
      ...(admittedRunId ? { runId: admittedRunId } : {}),
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
    const tools = resolveLoopbackTools(collectorSessionKey);

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

  it("resolves a plain surface for a subagent session the registry has no record of", () => {
    // The state a gateway restart leaves behind before the registry reloads.
    // Restart recovery of collector runs belongs to the registry restart
    // recovery path, so this resolver behaves exactly as it does on main.
    const names = resolveLoopbackTools(unregisteredCollectorSessionKey).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
  });
});

describe("collector contract is bound to the admitted collector run", () => {
  it("serves the plain surface to a session-scoped attach client on the same session", () => {
    // `openclaw attach` mints a session-scoped bearer and shares this loopback
    // server, but `resolveMcpRequestContext` gives that client no run id, so it
    // never presents the collector's admitted run. It must see exactly what main
    // gives it today: no result writer, and its ordinary requester tools.
    const names = resolveLoopbackTools(collectorSessionKey, {
      admittedRunId: null,
    }).map((tool) => tool.name);

    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");
    expect(names).toEqual(
      resolveLoopbackTools(plainSessionKey, { admittedRunId: null }).map((tool) => tool.name),
    );
  });

  it("writes nothing for an attach client, because the result tool is never listed", () => {
    const attachNames = resolveLoopbackTools(collectorSessionKey, {
      admittedRunId: null,
    }).map((tool) => tool.name);

    // `tools/call` resolves by name out of this exact list, so an attach client
    // naming the tool gets "Tool not available" and reaches no writer.
    expect(attachNames).not.toContain("structured_output");
    expect(getSubagentRunByRunId(runId)?.structuredOutput).toBeUndefined();
    expect(getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
  });

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
    // The `http` surface is reachable by any authorized gateway caller against
    // any session key, so it must not gain a direct writer into a collector's
    // durable result. Compare a collector child against a plain child: the two
    // http surfaces are identical.
    const collectorNames = resolveHttpToolNames(collectorSessionKey);
    const plainNames = resolveHttpToolNames(plainSessionKey);

    expect(collectorNames).not.toContain("structured_output");
    expect(collectorNames).toEqual(plainNames);
  });

  it("does not withhold requester-only tools from a collector session on the http surface", () => {
    const names = resolveHttpToolNames(collectorSessionKey);

    expect(names).toContain("sessions_yield");
    expect(names).toEqual(resolveHttpToolNames(schemalessCollectorSessionKey));
  });

  it("keeps operator tool policy authoritative for a collector session on the http surface", () => {
    const names = resolveHttpToolNames(collectorSessionKey, {
      allow: ["sessions_list"],
    });

    expect(names).toEqual(["sessions_list"]);
  });

  it("still applies the full contract on the loopback surface", () => {
    const names = resolveLoopbackTools(collectorSessionKey).map((tool) => tool.name);

    expect(names).toContain("structured_output");
    expect(names).not.toContain("sessions_yield");
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

  it("rejects the result when the caller stops owning the admitted collector run", async () => {
    const tools = resolveLoopbackTools(collectorSessionKey);
    const structuredOutput = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector output transport",
    );

    const entry = expectDefined(getSubagentRunByRunId(runId), "collector run");
    entry.runId = "cli-collector-rebound";
    entry.swarmRunId = "cli-collector-rebound";

    await expect(
      structuredOutput.execute("rebound-collector-result", {
        result: { answer: "ok" },
      }),
    ).rejects.toThrow("caller no longer owns the admitted collector run");
    expect(entry.structuredOutput).toBeUndefined();
    expect(entry.collectorCompletion).toBeUndefined();
  });

  it("records the result while the grant is still current", async () => {
    const tools = resolveLoopbackTools(collectorSessionKey, {
      isGrantCurrent: () => true,
    });
    const structuredOutput = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector output transport",
    );

    const result = await structuredOutput.execute("current-collector-result", {
      result: { answer: "ok" },
    });

    expect(result.details).toEqual({ status: "recorded" });
    expect(getSubagentRunByRunId(runId)?.structuredOutput).toEqual({
      structured: { answer: "ok" },
      invalidAttempts: 0,
    });
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

  it("withholds structured_output from a run-less context at the loopback entry point", async () => {
    // Same entry point the loopback server calls, with the request context an
    // attach grant produces: a bound session key and no admitted run.
    const names = await resolveLoopbackGrantToolNames(["read", "structured_output"], null);

    expect(names).toEqual(["read"]);
  });
});
