import fs from "node:fs";
import { Server } from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function registerRelay(
  id: string,
  options: Partial<Parameters<typeof registerOwnedNativeHookRelay>[0]> = {},
) {
  return registerOwnedNativeHookRelay({
    provider: "codex",
    agentId: "main",
    sessionId: id,
    runId: id,
    ...options,
  });
}

function failListener() {
  const error = new Error("fixture listener unavailable");
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
    queueMicrotask(() => this.emit("error", error));
    return this;
  });
  return error;
}

function requestPermission(
  relay: Pick<ReturnType<typeof registerNativeHookRelay>, "relayId" | "generation">,
  call: string,
) {
  return invokeNativeHook({
    provider: "codex",
    relayId: relay.relayId,
    generation: relay.generation,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      tool_name: "mcp__fixture__read",
      tool_use_id: call,
      tool_input: {},
    },
  });
}

function observeSettlement(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
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

describe("native hook relay gateway method", () => {
  it("cancels a closed one-shot Gateway connection and discards its late approval", async () => {
    await withOpenClawTestState({ label: "relay-gateway-disconnect" }, async () => {
      const entered = createDeferredCore<AbortSignal | undefined>();
      const release = createDeferredCore();
      const cancelled = createDeferredCore();
      const onResolution = vi.fn(() => cancelled.resolve());
      const admitExecution = vi.fn();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "gateway-disconnect",
        runId: "gateway-disconnect",
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
      const pending = invokeNativeHook(
        {
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "pre_tool_use",
          rawPayload: { tool_name: "Bash", tool_input: {}, tool_use_id: "disconnected-call" },
        },
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
        expect(
          nativeHookRelayState.pendingPreToolUseApprovals.has(
            JSON.stringify([relay.relayId, "disconnected-call"]),
          ),
        ).toBe(false);
        const next = await invokeNativeHook({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "post_tool_use",
          rawPayload: POST_TOOL_USE_PAYLOAD,
        });
        expect(next).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
      } finally {
        release.resolve();
        await pending;
        relay.unregister();
        await relay.drain();
      }
    });
  });

  it("returns its synchronous handle before reading stored MCP policy", async () => {
    await withOpenClawTestState({ label: "relay-policy-registration" }, async () => {
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
    });
  });

  it.each([false, true])(
    "waits for stored policy after listener failure (legacy policy: %s)",
    async (legacy) => {
      await withOpenClawTestState({ label: "relay-policy-gateway-fallback" }, async () => {
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
          expect(preparationSettled()).toBe(false);
          expect(invocationSettled()).toBe(false);
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
            expect(await invocation).toHaveBeenCalledWith(true, {
              stdout: "",
              stderr: "",
              exitCode: 0,
            });
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
      });
    },
  );

  it("keeps registration option values when the caller later mutates its input", async () => {
    await withOpenClawTestState({ label: "relay-policy-options" }, async () => {
      const requester = vi.fn(async () => "deny" as const);
      testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
      const params: Parameters<typeof registerNativeHookRelay>[0] = {
        provider: "codex",
        agentId: "main",
        sessionId: "policy-options",
        runId: "policy-options",
        autoApproveMcpTools: false,
      };
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
    });
  });

  it("drains admitted policy work after listener failure and unregister", async () => {
    await withOpenClawTestState({ label: "relay-policy-drain" }, async () => {
      const paused = pauseMcpPolicyRead();
      const listenerFailure = failListener();
      const relay = registerRelay("policy-drain");
      await expect(relay.ready).rejects.toBe(listenerFailure);
      await paused.entered.promise;
      relay.unregister();
      let drained = false;
      const draining = relay.drain().then(() => {
        drained = true;
      });
      try {
        await setImmediate();
        expect(drained).toBe(false);
        paused.resume.resolve();
        await draining;
        expect(paused.read.mock.calls.length).toBe(1);
      } finally {
        paused.resume.resolve();
        await paused.completed.promise;
        await draining;
      }
    });
  });

  it.each(["unregister", "owner-close", "abort"] as const)(
    "revalidates native authority after policy readiness during %s",
    async (closure) => {
      await withOpenClawTestState({ label: `relay-policy-${closure}` }, async () => {
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
          const respond = await invocation;
          // Invocation cancellation stops its wait before preparation rechecks the owner.
          expectInvalidRequest(respond, closure === "abort" ? "aborted" : expectedError);
          expect(requester.mock.calls.length).toBe(0);
        } finally {
          paused.resume.resolve();
          await paused.completed.promise;
          await Promise.allSettled([preparation, invocation]);
          relay.unregister();
          await relay.drain();
        }
      });
    },
  );

  it("keeps the original database and legacy gate after the ambient state directory changes", async () => {
    await withOpenClawTestState({ label: "relay-policy-state-owner" }, async (state) => {
      allowStoredTool();
      const foreign = path.join(state.root, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(resolveExecApprovalsPath({ OPENCLAW_STATE_DIR: foreign }), "{}");
      const relay = registerRelay("policy-state-owner");
      vi.stubEnv("OPENCLAW_STATE_DIR", foreign);
      try {
        await relay.ready;
        const respond = await requestPermission(relay, "policy-state-owner-call");
        expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
        expect(relay.deferMcpToolApprovals).toBe(true);
        expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: foreign }))).toBe(
          false,
        );
      } finally {
        relay.unregister();
        vi.unstubAllEnvs();
        await relay.drain();
      }
    });
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

  it("rejects unknown relay ids", async () => {
    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: "missing",
      event: "pre_tool_use",
      rawPayload: {},
    });

    expectInvalidRequest(respond, "not found");
  });

  it("rejects stale relay generations", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "relay-1",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });

    expectInvalidRequest(respond, "native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
  });
});

async function invokeNativeHook(params: Record<string, unknown>, connectionSignal?: AbortSignal) {
  const respond = viRespond();
  await expectDefined(
    nativeHookRelayHandlers["nativeHook.invoke"],
    'nativeHookRelayHandlers["nativeHook.invoke"] test invariant',
  )({
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

function expectInvalidRequest(respond: ReturnType<typeof viRespond>, message: string) {
  expect(respond.mock.calls[0]).toEqual([
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining(message) }),
  ]);
}

function viRespond() {
  return vi.fn();
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
