import fs from "node:fs";
import { Server } from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { nativeHookRelayState } from "../../agents/harness/native-hook-relay-state.js";
import {
  testing,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
} from "../../agents/harness/native-hook-relay.js";
import { resolveExecApprovalsPath } from "../../infra/exec-approvals-config.js";
import * as mcpGrants from "../../infra/exec-approvals-mcp.js";
import { ExecApprovalsMigrationRequiredError } from "../../infra/exec-approvals-migration-gate.js";
import { saveExecApprovals } from "../../infra/exec-approvals-store.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { nativeHookRelayHandlers } from "./native-hook-relay.js";

const handler = expectDefined(nativeHookRelayHandlers["nativeHook.invoke"], "native hook handler");

function registerRelay(
  id: string,
  options: Partial<Parameters<typeof registerOwnedNativeHookRelay>[0]> = {},
) {
  return registerOwnedNativeHookRelay({ ...relayParams(id), ...options });
}

function relayParams(id: string): Parameters<typeof registerNativeHookRelay>[0] {
  return { provider: "codex", agentId: "main", sessionId: id, runId: id };
}

function failListener() {
  const error = new Error("fixture listener unavailable");
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
    queueMicrotask(() => this.emit("error", error));
    return this;
  });
  return error;
}

type Relay = Pick<ReturnType<typeof registerNativeHookRelay>, "relayId" | "generation">;

function requestPermission(relay: Relay, call: string) {
  return invokeRelay(relay, "permission_request", {
    hook_event_name: "PermissionRequest",
    tool_name: "mcp__fixture__read",
    tool_use_id: call,
    tool_input: {},
  });
}

function invokeRelay(
  relay: Relay,
  event: string,
  rawPayload: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { relayId, generation } = relay;
  return invokeNativeHook({ provider: "codex", relayId, generation, event, rawPayload }, signal);
}

function expectSuccess(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
}

function withState(run: Parameters<typeof withOpenClawTestState>[1]) {
  return () => withOpenClawTestState({ label: "native-hook-relay" }, run);
}

function observeSettlement(promise: Promise<unknown>) {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  void promise.then(settle, settle);
  return () => settled;
}

function allowStoredTool() {
  saveExecApprovals({
    version: 1,
    agents: {
      main: { mcpTools: [{ server: "fixture", tool: "read", source: "allow-always", addedAt: 1 }] },
    },
  });
}

const POST_TOOL_USE_PAYLOAD = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_response: { output: "ok" },
};

afterEach(async () => {
  await testing.clearNativeHookRelaysForTests();
  vi.restoreAllMocks();
});

it(
  "discards approvals after Gateway disconnection",
  withState(async () => {
    const entered = createDeferredCore<AbortSignal | undefined>();
    const release = createDeferredCore();
    const cancelled = createDeferredCore();
    const onResolution = vi.fn(() => cancelled.resolve());
    const admitExecution = vi.fn();
    const relay = registerRelay("gateway-disconnect", {
      agentId: undefined,
      executionAdmission: { toolNames: ["exec"], admit: admitExecution },
      runBeforeToolCall: async ({ signal }) => {
        entered.resolve(signal);
        await release.promise;
        return {
          blocked: false,
          params: {},
          deferredApproval: {
            approval: { title: "fixture", description: "fixture", onResolution },
            toolName: "exec",
            baseParams: {},
          },
        };
      },
    });
    await relay.ready;
    const connection = new AbortController();
    const pending = invokeRelay(
      relay,
      "pre_tool_use",
      { tool_name: "Bash", tool_input: {}, tool_use_id: "disconnected-call" },
      connection.signal,
    );
    try {
      const signal = await entered.promise;
      connection.abort();
      expectInvalidRequest(await pending, "aborted");
      expect(signal?.aborted).toBe(true);
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
      release.resolve();
      await cancelled.promise;
      expect(onResolution).toHaveBeenCalledExactlyOnceWith("cancelled");
      expect(admitExecution).not.toHaveBeenCalled();
      const approvalKey = JSON.stringify([relay.relayId, "disconnected-call"]);
      expect(nativeHookRelayState.pendingPreToolUseApprovals.has(approvalKey)).toBe(false);
      expectSuccess(await invokeRelay(relay, "post_tool_use", POST_TOOL_USE_PAYLOAD));
    } finally {
      release.resolve();
      await pending;
      relay.unregister();
      await relay.drain();
    }
  }),
);

it(
  "returns before stored policy is read",
  withState(async () => {
    const read = vi.spyOn(mcpGrants, "loadMcpToolGrants");
    const relay = registerRelay("policy-registration");
    try {
      expect(typeof relay.commandForEvent("permission_request")).toBe("string");
      expect(read.mock.calls.length).toBe(0);
      await relay.ready;
      expect(read.mock.calls.length).toBe(1);
    } finally {
      relay.unregister();
      await relay.drain();
    }
  }),
);

it.each([false, true])(
  "waits for stored policy after listener failure (legacy policy: %s)",
  (legacy) =>
    withOpenClawTestState({ label: "relay-policy-gateway-fallback" }, async () => {
      const legacyPath = resolveExecApprovalsPath();
      const legacyPolicy = JSON.stringify({ version: 1, agents: {} });
      if (legacy) {
        fs.writeFileSync(legacyPath, legacyPolicy);
      } else {
        allowStoredTool();
      }
      const paused = pauseMcpPolicyRead();
      const listenerFailure = failListener();
      const requester = vi.fn(async () => (legacy ? ("allow" as const) : ("deny" as const)));
      testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
      const relay = registerRelay(legacy ? "policy-migration-fallback" : "policy-fallback");
      const preparation = relay.prepareInvocation();
      const preparationSettled = observeSettlement(preparation);
      const invocation = requestPermission(relay, "policy-fallback-call");
      const invocationSettled = observeSettlement(invocation);
      try {
        await expect(relay.ready).rejects.toBe(listenerFailure);
        await paused.entered.promise;
        await setImmediate();
        expect([preparationSettled(), invocationSettled()]).toEqual([false, false]);
        expect(requester).not.toHaveBeenCalled();
        expect(relay.deferMcpToolApprovals).toBeUndefined();
        paused.resume.resolve();
        if (legacy) {
          await expect(preparation).rejects.toBeInstanceOf(ExecApprovalsMigrationRequiredError);
          expectInvalidRequest(await invocation, `Legacy exec approvals exist at ${legacyPath}`);
          expect(relay.deferMcpToolApprovals).toBeUndefined();
          expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyPolicy);
        } else {
          await expect(preparation).resolves.toBeUndefined();
          expectSuccess(await invocation);
          expect(relay.deferMcpToolApprovals).toBe(true);
          expect(paused.read).toHaveBeenCalledOnce();
        }
        expect(requester).not.toHaveBeenCalled();
      } finally {
        paused.resume.resolve();
        await paused.completed.promise;
        await Promise.allSettled([preparation, invocation]);
        relay.unregister();
        if (legacy) {
          await expect(relay.drain()).rejects.toBeInstanceOf(ExecApprovalsMigrationRequiredError);
        } else {
          await relay.drain();
        }
      }
    }),
);

it(
  "snapshots caller-owned registration options",
  withState(async () => {
    const requester = vi.fn(async () => "deny" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
    const params = { ...relayParams("policy-options"), autoApproveMcpTools: false };
    const relay = registerNativeHookRelay(params);
    params.autoApproveMcpTools = true;
    try {
      await requestPermission(relay, "policy-options-call");
      expect(requester.mock.calls.length).toBe(1);
      expect(relay.deferMcpToolApprovals).toBe(false);
    } finally {
      relay.unregister();
      await testing.clearNativeHookRelaysForTests();
    }
  }),
);

it(
  "drains policy work after listener failure",
  withState(async () => {
    const paused = pauseMcpPolicyRead();
    const listenerFailure = failListener();
    const relay = registerRelay("policy-drain");
    await expect(relay.ready).rejects.toBe(listenerFailure);
    await paused.entered.promise;
    relay.unregister();
    const draining = relay.drain();
    const drained = observeSettlement(draining);
    try {
      await setImmediate();
      expect(drained()).toBe(false);
      paused.resume.resolve();
      await draining;
      expect(paused.read.mock.calls.length).toBe(1);
    } finally {
      paused.resume.resolve();
      await paused.completed.promise;
      await draining;
    }
  }),
);

it.each(["unregister", "owner-close", "abort"] as const)(
  "revalidates native authority after policy readiness during %s",
  (closure) =>
    withOpenClawTestState({ label: `relay-policy-${closure}` }, async () => {
      const paused = pauseMcpPolicyRead();
      const listenerFailure = failListener();
      const requester = vi.fn(async () => "deny" as const);
      testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
      const abort = new AbortController();
      let active = true;
      const relay = registerRelay("policy-authority", {
        signal: abort.signal,
        assertActive: () => {
          if (!active) {
            throw new Error("fixture native owner closed");
          }
        },
      });
      const preparation = relay.prepareInvocation();
      const preparationSettled = observeSettlement(preparation);
      const invocation = requestPermission(relay, "policy-authority-call");
      try {
        await expect(relay.ready).rejects.toBe(listenerFailure);
        await paused.entered.promise;
        await setImmediate();
        expect(preparationSettled()).toBe(false);
        if (closure === "unregister") {
          relay.unregister();
        } else if (closure === "abort") {
          abort.abort();
        } else {
          active = false;
        }
        paused.resume.resolve();
        const expectedError =
          closure === "owner-close" ? "fixture native owner closed" : "registration is inactive";
        await expect(preparation).rejects.toThrow(expectedError);
        // Invocation cancellation stops its wait before preparation rechecks the owner.
        expectInvalidRequest(await invocation, closure === "abort" ? "aborted" : expectedError);
        expect(requester.mock.calls.length).toBe(0);
      } finally {
        paused.resume.resolve();
        await paused.completed.promise;
        await Promise.allSettled([preparation, invocation]);
        relay.unregister();
        await relay.drain();
      }
    }),
);

it(
  "binds policy to the original state directory",
  withState(async (state) => {
    allowStoredTool();
    const foreign = path.join(state.root, "foreign");
    const foreignDb = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: foreign });
    fs.mkdirSync(foreign);
    fs.writeFileSync(resolveExecApprovalsPath({ OPENCLAW_STATE_DIR: foreign }), "{}");
    const relay = registerRelay("policy-state-owner");
    vi.stubEnv("OPENCLAW_STATE_DIR", foreign);
    try {
      await relay.ready;
      expectSuccess(await requestPermission(relay, "policy-state-owner-call"));
      expect(relay.deferMcpToolApprovals).toBe(true);
      expect(fs.existsSync(foreignDb)).toBe(false);
    } finally {
      relay.unregister();
      vi.unstubAllEnvs();
      await relay.drain();
    }
  }),
);

it("rejects unknown relay ids", async () => {
  const respond = await invokeNativeHook({
    provider: "codex",
    relayId: "missing",
    event: "pre_tool_use",
    rawPayload: {},
  });

  expectInvalidRequest(respond, "not found");
});

it("accepts a live relay invocation", async () => {
  const relay = registerNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    allowedEvents: ["post_tool_use"],
  });

  const respond = await invokeNativeHook({
    provider: "codex",
    relayId: relay.relayId,
    generation: relay.generation,
    event: "post_tool_use",
    rawPayload: POST_TOOL_USE_PAYLOAD,
  });

  expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
  expect(testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);
});

it("rejects stale relay generations", async () => {
  const params = {
    provider: "codex" as const,
    relayId: "relay-1",
    sessionId: "session-1",
    allowedEvents: ["post_tool_use" as const],
  };
  const first = registerNativeHookRelay({ ...params, runId: "run-1" });
  registerNativeHookRelay({ ...params, runId: "run-2" });

  const respond = await invokeRelay(first, "post_tool_use", POST_TOOL_USE_PAYLOAD);

  expectInvalidRequest(respond, "native hook relay bridge stale registration");
  expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
});

async function invokeNativeHook(params: Record<string, unknown>, connectionSignal?: AbortSignal) {
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "1", method: "nativeHook.invoke" },
    params,
    client: connectionSignal
      ? {
          connectionSignal,
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "cli", version: "test", platform: "test", mode: "cli" },
          },
        }
      : null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return respond;
}

function expectInvalidRequest(respond: ReturnType<typeof vi.fn>, message: string) {
  expect(respond.mock.calls[0]).toEqual([
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining(message) }),
  ]);
}

function pauseMcpPolicyRead() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const completed = createDeferredCore();
  const load = mcpGrants.loadMcpToolGrants;
  const read = vi.spyOn(mcpGrants, "loadMcpToolGrants").mockImplementation(async (...args) => {
    entered.resolve();
    await resume.promise;
    try {
      return await load(...args);
    } finally {
      completed.resolve();
    }
  });
  return { entered, resume, completed, read };
}
