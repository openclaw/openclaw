/**
 * B2.1 — delegated execution lineage across the real child/subagent Gateway boundary.
 *
 * These tests do not call the ownership subsystem as their entry point. They drive
 * the production seams the runtime actually uses:
 *   - callNativeSubagentGateway(): the in-process child-run launch.
 *   - callGatewayTool(): the out-of-process (WebSocket) child-run launch that mints
 *     the signed Host/Gateway execution identity token.
 *   - resolveChildRunDelegatedExecutionLineage()/runWithChildRunDelegatedExecutionLineage():
 *     the child-side rebind that runs after trusted Gateway identity validation.
 *   - resolvePreparedRunAdmission() / runBeforeToolCallHook(): the already-wired
 *     Host admission gates that must see the inherited lineage automatically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const runtimeMock = vi.hoisted(() => ({
  dispatchGatewayMethodInProcess: vi.fn(),
  hasInProcessGatewayContext: vi.fn(() => false),
  callGateway: vi.fn(),
}));
const callMock = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../agents/subagents/spawn/subagent-spawn.runtime.js", async () => {
  const scopes = await import("../gateway/method-scopes.js");
  return {
    ...scopes,
    dispatchGatewayMethodInProcess: runtimeMock.dispatchGatewayMethodInProcess,
    hasInProcessGatewayContext: runtimeMock.hasInProcessGatewayContext,
    callGateway: runtimeMock.callGateway,
    ensureContextEnginesInitialized: vi.fn(),
    forkSessionEntryFromParent: vi.fn(),
    getGlobalHookRunner: vi.fn(),
    getRuntimeConfig: vi.fn(),
    prepareModelChoice: vi.fn(),
    resolveContextEngine: vi.fn(),
  };
});

vi.mock("../gateway/call.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
  return { ...actual, callGateway: callMock.callGateway };
});

import {
  createOperationalRunInstanceRef,
  resolvePreparedRunAdmission,
} from "../agents/admitted-run-context.js";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.policy.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import { callNativeSubagentGateway } from "../agents/subagents/spawn/subagent-spawn-gateway.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import type { AgentRuntimeIdentity } from "../gateway/agent-runtime-identity-token.js";
import { verifyAgentRuntimeIdentityToken } from "../gateway/agent-runtime-identity-token.js";
import {
  DelegatedExecutionChildLineageError,
  resolveChildRunDelegatedExecutionLineage,
  runWithChildRunDelegatedExecutionLineage,
} from "../gateway/agent-turn/agent-run-execution-lineage.js";
import { readInProcessAgentRuntimeIdentity } from "../gateway/in-process-agent-runtime-identity.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { acquireDelegatedExecutionOwnership } from "./delegated-execution-ownership.js";
import { DelegatedExecutionDeniedError } from "./delegated-execution-run-admission.js";
import { runWithDelegatedExecutionLineage } from "./delegated-execution-scope.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const home = tempDirs.make("openclaw-b2-delegated-");
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", home + "/.openclaw");
  closeOpenClawStateDatabaseForTest();
  runtimeMock.dispatchGatewayMethodInProcess.mockReset();
  runtimeMock.hasInProcessGatewayContext.mockReset();
  runtimeMock.hasInProcessGatewayContext.mockReturnValue(false);
  runtimeMock.callGateway.mockReset();
  callMock.callGateway.mockReset();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetAgentRunRegistryForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  envSnapshot.restore();
});

function stateOptions() {
  return { env: process.env };
}

function seedLock(params: { delegationRef: string; lineageRef: string }) {
  acquireDelegatedExecutionOwnership({
    delegationRef: params.delegationRef,
    ownerKind: "plugin",
    ownerId: "delegate-plugin",
    taskScopeRef: "task:" + params.delegationRef,
    lineageRef: params.lineageRef,
    options: stateOptions(),
  });
  openOpenClawStateDatabase(stateOptions());
}

function childAdmissionContext(runId: string) {
  return { operationalRunInstance: Object.freeze({ instanceId: "instance:" + runId, runId }) };
}

function parentCaller(operationalRunInstance: ReturnType<typeof createOperationalRunInstanceRef>) {
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  return {
    authority,
    identity: {
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
    },
  };
}

const SPAWN_CONTEXT = () =>
  buildSubagentExecutionSessionSpawnContext({
    enabled: true,
    backend: "subagent",
    parentAgentId: "main",
    requesterRef: "agent:main:main",
    controllerRef: "agent:main:main",
    depth: 1,
    targetAgentId: "main",
    sandbox: "inherit",
  });

describe("B2.1 delegated lineage across the subagent Gateway boundary", () => {
  it("TEST 1 — in-process child launch carries the inherited lineage and the child admission is denied", async () => {
    seedLock({ delegationRef: "delegation:b2-inproc", lineageRef: "lineage:b2-inproc" });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-b2-inproc");
    const { authority, identity } = parentCaller(operationalRunInstance);
    let childIdentity: AgentRuntimeIdentity | undefined;
    runtimeMock.hasInProcessGatewayContext.mockReturnValue(true);
    runtimeMock.dispatchGatewayMethodInProcess.mockImplementation(
      async (_method: string, _params: Record<string, unknown>, options: object) => {
        childIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: "b2-child-inproc", status: "accepted" };
      },
    );
    const request = withSubagentGatewayExecutionIdentity(
      { method: "agent", params: { message: "child", idempotencyKey: "b2-child-inproc" } },
      { sessionSpawnContext: SPAWN_CONTEXT() },
    );
    try {
      const launch = await withGatewayToolCallerIdentity(identity, () =>
        runWithDelegatedExecutionLineage("lineage:b2-inproc", () =>
          callNativeSubagentGateway(request),
        ),
      );
      expect(launch.response).toMatchObject({ runId: "b2-child-inproc" });
      expect(childIdentity?.delegatedExecutionLineage).toBe("lineage:b2-inproc");

      const inherited = resolveChildRunDelegatedExecutionLineage({
        identity: childIdentity,
        identityCurrent: true,
      });
      expect(inherited).toBe("lineage:b2-inproc");
      await expect(
        runWithChildRunDelegatedExecutionLineage(inherited, () =>
          resolvePreparedRunAdmission({
            runId: "b2-child-inproc",
            runtimeKind: "embedded",
            admittedRunContext: childAdmissionContext("b2-child-inproc"),
          }),
        ),
      ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("TEST 2 — out-of-process child launch carries the lineage on the signed token and the child admission is denied", async () => {
    seedLock({ delegationRef: "delegation:b2-outproc", lineageRef: "lineage:b2-outproc" });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-b2-outproc");
    const { authority, identity } = parentCaller(operationalRunInstance);
    callMock.callGateway.mockImplementation(async () => ({
      runId: "b2-child-outproc",
      status: "accepted",
    }));
    try {
      await withGatewayToolCallerIdentity(identity, () =>
        runWithDelegatedExecutionLineage("lineage:b2-outproc", () =>
          callGatewayTool(
            "agent",
            {},
            { message: "child", idempotencyKey: "b2-child-outproc" },
            { requireAgentRuntimeIdentity: true },
          ),
        ),
      );
      const token = callMock.callGateway.mock.calls[0]?.[0]?.agentRuntimeIdentityToken;
      expect(typeof token).toBe("string");
      // The receiver only trusts the lineage after the HMAC verifies.
      const received = await verifyAgentRuntimeIdentityToken(token as string);
      expect(received?.delegatedExecutionLineage).toBe("lineage:b2-outproc");

      const inherited = resolveChildRunDelegatedExecutionLineage({
        identity: received,
        identityCurrent: true,
      });
      expect(inherited).toBe("lineage:b2-outproc");
      await expect(
        runWithChildRunDelegatedExecutionLineage(inherited, () =>
          resolvePreparedRunAdmission({
            runId: "b2-child-outproc",
            runtimeKind: "embedded",
            admittedRunContext: childAdmissionContext("b2-child-outproc"),
          }),
        ),
      ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("TEST 3 — an inherited lineage denies a protected child tool before it executes", async () => {
    seedLock({ delegationRef: "delegation:b2-tool", lineageRef: "lineage:b2-tool" });
    const inherited = resolveChildRunDelegatedExecutionLineage({
      identity: { delegatedExecutionLineage: "lineage:b2-tool" } as AgentRuntimeIdentity,
      identityCurrent: true,
    });
    const outcome = await runWithChildRunDelegatedExecutionLineage(inherited, () =>
      runBeforeToolCallHook({ toolName: "exec", params: { command: "echo hi" }, ctx: {} as never }),
    );
    expect(outcome.blocked).toBe(true);
    expect(outcome.deniedReason).toBe("delegated-execution-ownership");
  });

  it("TEST 4 — a non-delegated parent produces no lineage and the child stays DIRECT", async () => {
    seedLock({ delegationRef: "delegation:b2-direct", lineageRef: "lineage:b2-direct" });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-b2-direct");
    const { authority, identity } = parentCaller(operationalRunInstance);
    let childIdentity: AgentRuntimeIdentity | undefined;
    runtimeMock.hasInProcessGatewayContext.mockReturnValue(true);
    runtimeMock.dispatchGatewayMethodInProcess.mockImplementation(
      async (_method: string, _params: Record<string, unknown>, options: object) => {
        childIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: "b2-child-direct", status: "accepted" };
      },
    );
    const request = withSubagentGatewayExecutionIdentity(
      { method: "agent", params: { message: "child", idempotencyKey: "b2-child-direct" } },
      { sessionSpawnContext: SPAWN_CONTEXT() },
    );
    try {
      // No delegated scope wraps this launch: the parent is unrelated.
      await withGatewayToolCallerIdentity(identity, () => callNativeSubagentGateway(request));
      expect(childIdentity?.delegatedExecutionLineage).toBeUndefined();
      const inherited = resolveChildRunDelegatedExecutionLineage({
        identity: childIdentity,
        identityCurrent: true,
      });
      expect(inherited).toBeUndefined();
      const admitted = await runWithChildRunDelegatedExecutionLineage(inherited, () =>
        resolvePreparedRunAdmission({
          runId: "b2-child-direct",
          runtimeKind: "embedded",
          admittedRunContext: childAdmissionContext("b2-child-direct"),
        }),
      );
      expect(admitted.operationalRunInstance.runId).toBe("b2-child-direct");
      const tool = await runWithChildRunDelegatedExecutionLineage(inherited, () =>
        runBeforeToolCallHook({ toolName: "exec", params: {}, ctx: {} as never }),
      );
      expect(tool.deniedReason).not.toBe("delegated-execution-ownership");
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("TEST 5 — forged or plain wire metadata is never accepted as a delegated lineage", async () => {
    // A plain caller-supplied object that looks like an identity is not trusted:
    // the seam requires the trusted identity to be current, which only the Host
    // validator can assert.
    expect(() =>
      resolveChildRunDelegatedExecutionLineage({
        identity: { delegatedExecutionLineage: "lineage:forged" } as AgentRuntimeIdentity,
        identityCurrent: false,
      }),
    ).toThrow(DelegatedExecutionChildLineageError);
    expect(
      resolveChildRunDelegatedExecutionLineage({ identity: undefined, identityCurrent: true }),
    ).toBeUndefined();

    // A tampered signed token (payload rewritten without re-signing) is refused.
    const operationalRunInstance = createOperationalRunInstanceRef("parent-b2-forged");
    const { authority, identity } = parentCaller(operationalRunInstance);
    callMock.callGateway.mockImplementation(async () => ({
      runId: "b2-child-forged",
      status: "accepted",
    }));
    try {
      await withGatewayToolCallerIdentity(identity, () =>
        runWithDelegatedExecutionLineage("lineage:b2-forged", () =>
          callGatewayTool(
            "agent",
            {},
            { message: "child", idempotencyKey: "b2-child-forged" },
            { requireAgentRuntimeIdentity: true },
          ),
        ),
      );
      const token = callMock.callGateway.mock.calls[0]?.[0]?.agentRuntimeIdentityToken as string;
      const [payloadPart, signature] = token.split(".");
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      payload.delegatedExecutionLineage = "lineage:forged";
      const forged =
        Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") + "." + signature;
      expect(await verifyAgentRuntimeIdentityToken(forged)).toBeUndefined();
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("TEST 6 — a stale trusted parent identity never re-binds the lineage and fails closed", async () => {
    seedLock({ delegationRef: "delegation:b2-stale", lineageRef: "lineage:b2-stale" });
    expect(() =>
      resolveChildRunDelegatedExecutionLineage({
        identity: { delegatedExecutionLineage: "lineage:b2-stale" } as AgentRuntimeIdentity,
        identityCurrent: false,
      }),
    ).toThrow(DelegatedExecutionChildLineageError);

    // With no lineage carried at all, the child is not forced through the gate.
    expect(
      resolveChildRunDelegatedExecutionLineage({ identity: undefined, identityCurrent: false }),
    ).toBeUndefined();
  });
});
