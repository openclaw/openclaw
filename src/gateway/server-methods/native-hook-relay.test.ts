/**
 * Tests for relaying native hook events through gateway request handlers.
 */

import fs from "node:fs";
import { Server } from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
} from "../../agents/harness/native-hook-relay.js";
import { resolveExecApprovalsPath } from "../../infra/exec-approvals-config.js";
import * as mcpGrants from "../../infra/exec-approvals-mcp.js";
import { ExecApprovalsMigrationRequiredError } from "../../infra/exec-approvals-migration-gate.js";
import { saveExecApprovals } from "../../infra/exec-approvals-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { nativeHookRelayHandlers } from "./native-hook-relay.js";

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
  it("returns its synchronous handle before reading stored MCP policy", async () => {
    await withOpenClawTestState({ label: "relay-policy-registration" }, async () => {
      const read = vi.spyOn(mcpGrants, "loadMcpToolGrants");
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        agentId: "main",
        sessionId: "policy-registration",
        runId: "policy-registration",
      });
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

  it("waits for stored policy through Gateway when the locator cannot publish", async () => {
    await withOpenClawTestState({ label: "relay-policy-gateway-fallback" }, async () => {
      saveExecApprovals({
        version: 1,
        agents: {
          main: {
            mcpTools: [{ server: "fixture", tool: "read", source: "allow-always", addedAt: 1 }],
          },
        },
      });
      const { entered, resume, completed, read } = pauseMcpPolicyRead();
      const listenerFailure = new Error("fixture listener unavailable");
      vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
        queueMicrotask(() => this.emit("error", listenerFailure));
        return this;
      });
      const requester = vi.fn(async () => "deny" as const);
      testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        agentId: "main",
        sessionId: "policy-fallback",
        runId: "policy-fallback",
      });
      let settled = false;
      let preparationSettled = false;
      const preparation = relay.prepareInvocation();
      void preparation.then(
        () => {
          preparationSettled = true;
        },
        () => {
          preparationSettled = true;
        },
      );
      const invocation = invokeNativeHook({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__fixture__read",
          tool_use_id: "policy-fallback-call",
          tool_input: {},
        },
      }).then((respond) => {
        settled = true;
        return respond;
      });
      try {
        await expect(relay.ready).rejects.toBe(listenerFailure);
        await entered.promise;
        await setImmediate();
        expect(settled).toBe(false);
        expect(preparationSettled).toBe(false);
        expect(requester.mock.calls.length).toBe(0);
        expect(relay.deferMcpToolApprovals).toBeUndefined();
        resume.resolve();
        await expect(preparation).resolves.toBeUndefined();
        const respond = await invocation;
        expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
        expect(relay.deferMcpToolApprovals).toBe(true);
        expect(read.mock.calls.length).toBe(1);
        expect(requester.mock.calls.length).toBe(0);
      } finally {
        resume.resolve();
        await completed.promise;
        await Promise.allSettled([preparation, invocation]);
        relay.unregister();
        await relay.drain();
      }
    });
  });

  it("preserves a pending legacy-policy failure after direct publication has failed", async () => {
    await withOpenClawTestState({ label: "relay-policy-migration-fallback" }, async () => {
      const legacyPath = resolveExecApprovalsPath();
      const legacyPolicy = JSON.stringify({ version: 1, agents: {} });
      fs.writeFileSync(legacyPath, legacyPolicy);
      const paused = pauseMcpPolicyRead();
      const listenerFailure = new Error("fixture listener unavailable");
      vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
        queueMicrotask(() => this.emit("error", listenerFailure));
        return this;
      });
      const requester = vi.fn(async () => "allow" as const);
      testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        agentId: "main",
        sessionId: "policy-migration-fallback",
        runId: "policy-migration-fallback",
      });
      let preparationSettled = false;
      const preparation = relay.prepareInvocation();
      void preparation.then(
        () => {
          preparationSettled = true;
        },
        () => {
          preparationSettled = true;
        },
      );
      const invocation = invokeNativeHook({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__fixture__read",
          tool_use_id: "policy-migration-fallback-call",
          tool_input: {},
        },
      });
      try {
        await expect(relay.ready).rejects.toBe(listenerFailure);
        await paused.entered.promise;
        await setImmediate();
        expect(preparationSettled).toBe(false);
        expect(requester.mock.calls.length).toBe(0);
        paused.resume.resolve();
        await expect(preparation).rejects.toBeInstanceOf(ExecApprovalsMigrationRequiredError);
        const respond = await invocation;
        expectInvalidRequest(respond, `Legacy exec approvals exist at ${legacyPath}`);
        expect(relay.deferMcpToolApprovals).toBeUndefined();
        expect(requester.mock.calls.length).toBe(0);
        expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyPolicy);
      } finally {
        paused.resume.resolve();
        await paused.completed.promise;
        await Promise.allSettled([preparation, invocation]);
        relay.unregister();
        await expect(relay.drain()).rejects.toBeInstanceOf(ExecApprovalsMigrationRequiredError);
      }
    });
  });

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
        await invokeNativeHook({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: "mcp__fixture__read",
            tool_use_id: "policy-options-call",
            tool_input: {},
          },
        });
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
      const listenerFailure = new Error("fixture listener unavailable");
      vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
        queueMicrotask(() => this.emit("error", listenerFailure));
        return this;
      });
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        agentId: "main",
        sessionId: "policy-drain",
        runId: "policy-drain",
      });
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
        const listenerFailure = new Error("fixture listener unavailable");
        vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
          queueMicrotask(() => this.emit("error", listenerFailure));
          return this;
        });
        const requester = vi.fn(async () => "deny" as const);
        testing.setNativeHookRelayPermissionApprovalRequesterForTests(requester);
        const abort = new AbortController();
        let active = true;
        const relay = registerOwnedNativeHookRelay({
          provider: "codex",
          agentId: "main",
          sessionId: "policy-authority",
          runId: "policy-authority",
          signal: abort.signal,
          assertActive: () => {
            if (!active) {
              throw new Error("fixture native owner closed");
            }
          },
        });
        let preparationSettled = false;
        const preparation = relay.prepareInvocation();
        void preparation.then(
          () => {
            preparationSettled = true;
          },
          () => {
            preparationSettled = true;
          },
        );
        const invocation = invokeNativeHook({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: "mcp__fixture__read",
            tool_use_id: "policy-authority-call",
            tool_input: {},
          },
        });
        try {
          await expect(relay.ready).rejects.toBe(listenerFailure);
          await paused.entered.promise;
          await setImmediate();
          expect(preparationSettled).toBe(false);
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
          expectInvalidRequest(respond, expectedError);
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
      saveExecApprovals({
        version: 1,
        agents: {
          main: {
            mcpTools: [{ server: "fixture", tool: "read", source: "allow-always", addedAt: 1 }],
          },
        },
      });
      const foreign = path.join(state.root, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(resolveExecApprovalsPath({ OPENCLAW_STATE_DIR: foreign }), "{}");
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        agentId: "main",
        sessionId: "policy-state-owner",
        runId: "policy-state-owner",
      });
      vi.stubEnv("OPENCLAW_STATE_DIR", foreign);
      try {
        await relay.ready;
        const respond = await invokeNativeHook({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: "mcp__fixture__read",
            tool_use_id: "policy-state-owner-call",
            tool_input: {},
          },
        });
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

async function invokeNativeHook(params: Record<string, unknown>) {
  const respond = viRespond();
  await expectDefined(
    nativeHookRelayHandlers["nativeHook.invoke"],
    'nativeHookRelayHandlers["nativeHook.invoke"] test invariant',
  )({
    req: { type: "req", id: "1", method: "nativeHook.invoke" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return respond;
}

function expectInvalidRequest(respond: ReturnType<typeof viRespond>, message: string) {
  const call = respond.mock.calls.at(0) as
    | [boolean, unknown, { code?: string; message?: string }]
    | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  expect(call?.[2]?.code).toBe("INVALID_REQUEST");
  expect(call?.[2]?.message).toContain(message);
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
