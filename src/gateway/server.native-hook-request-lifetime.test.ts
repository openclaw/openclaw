// Real Gateway proof: run only with isolated SQLite coordination.
import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createAdmittedHostCapabilityTestFixture } from "../agents/harness/host-capability.test-support.js";
import { nativeHookRelayState } from "../agents/harness/native-hook-relay-state.js";
import {
  invokeNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "../agents/harness/native-hook-relay.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import { callGateway } from "./call.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import * as approvalShared from "./server-methods/approval-shared.js";
import { nativeHookRelayHandlers } from "./server-methods/native-hook-relay.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

describe("native hook relay WebSocket request lifetime", () => {
  it("preserves admitted foreground and claimed-child execution after callGateway closes its connection", async ({
    signal,
  }) => {
    const assertions = new Map<string, () => void>();
    const connections: AbortSignal[] = [];
    const handler = expectDefined(
      nativeHookRelayHandlers["nativeHook.invoke"],
      "native hook handler",
    );
    const observation = vi
      .spyOn(nativeHookRelayHandlers, "nativeHook.invoke")
      .mockImplementation(async (request) => {
        connections.push(
          expectDefined(request.client?.connectionSignal, "Gateway connection signal"),
        );
        await handler(request);
      });
    let gateway: GatewayHarness | undefined;
    let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
    let relay: ReturnType<typeof registerOwnedNativeHookRelay> | undefined;
    let childAdmissionCurrent = true;
    try {
      const token = "native-hook-close-fixture";
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "token", token } },
      });
      await gateway.server.startupSettled;
      host = await createAdmittedHostCapabilityTestFixture({
        sessionId: "native-gateway-execution",
        runId: "native-gateway-execution",
      });
      relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "native-gateway-execution",
        runId: "native-gateway-execution",
        runBeforeToolCall: host.hostCapabilities.runBeforeToolCall,
        assertActive: host.hostCapabilities.assertActive,
        executionAdmission: {
          toolNames: ["exec"],
          admit: (invocation, assertCurrent) => {
            assertions.set(
              expectDefined(invocation.toolUseId, "native tool call id"),
              assertCurrent,
            );
          },
        },
        retention: {
          readClaim: (rawPayload) =>
            isRecord(rawPayload) && typeof rawPayload.agent_id === "string"
              ? rawPayload.agent_id
              : undefined,
          shouldRetainAfterForegroundClose: () => childAdmissionCurrent,
          allowPreToolUse: (claim) => claim === "child-thread",
          awaitForegroundAdmission: async (claim) =>
            claim === "child-thread" ? () => childAdmissionCurrent : undefined,
          onDispose: () => {},
        },
      });
      await relay.ready;
      for (const child of [false, true]) {
        if (child) {
          host.closeHost();
          const assertForegroundCurrent = expectDefined(
            assertions.get("foreground-command"),
            "foreground guard",
          );
          expect.soft(assertForegroundCurrent).toThrow("host capability is no longer active");
          relay.unregister();
        }
        const toolUseId = child ? "child-command" : "foreground-command";
        await expect(
          callGateway({
            url: `ws://127.0.0.1:${gateway.port}`,
            token,
            config: { gateway: { mode: "local", auth: { mode: "token" } } },
            deviceIdentity: null,
            scopes: ["operator.admin"],
            method: "nativeHook.invoke",
            params: {
              provider: "codex",
              relayId: relay.relayId,
              generation: relay.generation,
              event: "pre_tool_use",
              rawPayload: {
                ...(child ? { agent_id: "child-thread" } : {}),
                tool_name: "Bash",
                tool_use_id: toolUseId,
                tool_input: { command: "true" },
              },
            },
            signal,
          }),
        ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
        const connection = expectDefined(connections.at(-1), "completed Gateway connection");
        if (!connection.aborted) {
          await once(connection, "abort", { signal });
        }
        expect(connection.aborted).toBe(true);
        const assertCurrent = expectDefined(assertions.get(toolUseId), "admitted execution guard");
        expect.soft(assertCurrent).not.toThrow();
      }
      expect(connections).toHaveLength(2);
      expect(assertions.size).toBe(2);
      const assertChildCurrent = expectDefined(
        assertions.get("child-command"),
        "claimed child guard",
      );
      expect.soft(assertChildCurrent).not.toThrow();
      childAdmissionCurrent = false;
      expect.soft(assertChildCurrent).toThrow("retained invocation not allowed");
    } finally {
      childAdmissionCurrent = false;
      relay?.unregister();
      host?.closeHost();
      host?.closeAdmission();
      await relay?.drain();
      await gateway?.server.close();
      observation.mockRestore();
    }
  });

  it.for([false, true])(
    "keeps accepted approval ownership across a lost callback (admitted host: %s)",
    async (owned, { signal }) => {
      const accepted = createDeferredCore<string>();
      const records = new Map<string, Array<{ id: string; claimId?: string }>>();
      const responses: Array<() => void> = [];
      const handlers: Promise<unknown>[] = [];
      const pending: Promise<unknown>[] = [];
      const resolved: string[] = [];
      const originalRequest = approvalShared.handlePendingApprovalRequest;
      const observation = vi
        .spyOn(approvalShared, "handlePendingApprovalRequest")
        .mockImplementation((params) => {
          const toolCallId =
            "toolCallId" in params.record.request ? params.record.request.toolCallId : undefined;
          if (params.approvalKind !== "plugin" || typeof toolCallId !== "string") {
            return originalRequest(params);
          }
          const calls = records.get(toolCallId) ?? [];
          calls.push({
            id: params.record.id,
            claimId: params.record.agentRuntimeDelegatedAuthority?.claimId,
          });
          records.set(toolCallId, calls);
          const holdAck = toolCallId === "call-a" && calls.length === 1;
          const run = originalRequest({
            ...params,
            respond: (...args) => {
              const payload = args[1];
              if (
                holdAck &&
                payload &&
                typeof payload === "object" &&
                "status" in payload &&
                payload.status === "accepted"
              ) {
                // Delay only delivery of the real accepted acknowledgement, after
                // the owner has persisted and published its approval request.
                responses.push(() => params.respond(...args));
                accepted.resolve(params.record.id);
              } else {
                params.respond(...args);
              }
            },
          });
          handlers.push(run.catch(() => {}));
          return run;
        });
      let gateway: GatewayHarness | undefined;
      let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
      let relay: ReturnType<typeof registerOwnedNativeHookRelay> | undefined;
      let reviewer: WebSocket | undefined;
      const firstAbort = new AbortController();
      const releaseResponses = () => {
        for (const respond of responses.splice(0)) {
          respond();
        }
      };
      signal.addEventListener("abort", releaseResponses, { once: true });
      try {
        gateway = await createGatewaySuiteHarness({ serverOptions: { bind: "loopback" } });
        await gateway.server.startupSettled;
        reviewer = await gateway.openWs();
        await connectOk(reviewer, {
          scopes: ["operator.admin"],
          caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        });
        reviewer.on("message", (data) => {
          const message = JSON.parse(rawDataToString(data));
          if (message.type === "event" && message.event === "plugin.approval.resolved") {
            resolved.push(message.payload.id);
          }
        });
        if (owned) {
          host = await createAdmittedHostCapabilityTestFixture({
            agentId: "main",
            sessionId: "native-approval-owner",
            sessionKey: "agent:main:native-approval-owner",
            runId: "native-approval-owner",
          });
        }
        relay = registerOwnedNativeHookRelay({
          provider: "codex",
          sessionId: "native-approval-owner",
          runId: "native-approval-owner",
          ...(host
            ? {
                approvalHost: host.hostCapabilities,
                assertActive: host.hostCapabilities.assertActive,
              }
            : {}),
        });
        await relay.ready;
        const invoke = (toolCallId: string, invocationSignal?: AbortSignal) => {
          const request = invokeNativeHookRelay(
            {
              provider: "codex",
              relayId: relay!.relayId,
              event: "permission_request",
              rawPayload: { tool_name: "fixture", tool_use_id: toolCallId, tool_input: {} },
            },
            invocationSignal,
          );
          pending.push(request.catch(() => {}));
          return request;
        };
        const first = invoke("call-a", firstAbort.signal);
        const id = await racePromiseWithAbortSignal(
          Promise.race([
            accepted.promise,
            first.then(() => {
              throw new Error("relay completed before the accepted acknowledgement");
            }),
          ]),
          signal,
        );
        expect(await getOperatorApprovalDetailed({ id })).toMatchObject({
          outcome: "found",
          record: { status: "pending" },
        });
        const other = owned ? invoke("call-b") : undefined;
        if (owned) {
          await vi.waitFor(() => expect(records.get("call-b")).toHaveLength(1));
          expect(records.get("call-a")?.[0]?.claimId).toBeDefined();
          expect(records.get("call-b")?.[0]?.claimId).toBeDefined();
          expect(records.get("call-b")?.[0]?.claimId).not.toBe(records.get("call-a")?.[0]?.claimId);
        }
        firstAbort.abort();
        await expect(first).rejects.toThrow(/abort/i);
        if (owned) {
          await vi.waitFor(async () =>
            expect(await getOperatorApprovalDetailed({ id })).toMatchObject({
              outcome: "found",
              record: { status: "cancelled", terminalReason: "run-aborted" },
            }),
          );
          await vi.waitFor(() => expect(resolved).toContain(id));
          expect(
            await getOperatorApprovalDetailed({ id: records.get("call-b")![0]!.id }),
          ).toMatchObject({
            outcome: "found",
            record: { status: "pending" },
          });
          expect(() => host!.hostCapabilities.assertActive()).not.toThrow();
        } else {
          expect(await getOperatorApprovalDetailed({ id })).toMatchObject({
            outcome: "found",
            record: { status: "pending" },
          });
          expect(resolved).not.toContain(id);
        }
        const retry = invoke("call-a");
        await vi.waitFor(() =>
          expect(
            [...nativeHookRelayState.pendingPermissionApprovals.values()].some(
              (entry) => entry.waiters === 1,
            ),
          ).toBe(true),
        );
        if (owned) {
          await vi.waitFor(() => expect(records.get("call-a")).toHaveLength(2));
        } else {
          expect(records.get("call-a")).toHaveLength(1);
        }
        releaseResponses();
        const retryId = records.get("call-a")!.at(-1)!.id;
        expect(
          (
            await rpcReq(reviewer, "plugin.approval.resolve", {
              id: retryId,
              decision: "allow-once",
            })
          ).ok,
        ).toBe(true);
        expect(JSON.parse((await retry).stdout).hookSpecificOutput.decision.behavior).toBe("allow");
        if (other) {
          const otherId = records.get("call-b")![0]!.id;
          expect(
            (
              await rpcReq(reviewer, "plugin.approval.resolve", {
                id: otherId,
                decision: "allow-once",
              })
            ).ok,
          ).toBe(true);
          expect(JSON.parse((await other).stdout).hookSpecificOutput.decision.behavior).toBe(
            "allow",
          );
          expect(() => host!.hostCapabilities.assertActive()).not.toThrow();
        }
      } finally {
        firstAbort.abort();
        releaseResponses();
        relay?.unregister();
        host?.closeHost();
        host?.closeAdmission();
        // Public requests intentionally survive disconnection; explicitly settle
        // only this fixture's still-pending approvals before closing the server.
        if (reviewer?.readyState === 1) {
          for (const values of records.values()) {
            for (const { id } of values) {
              const stored = await getOperatorApprovalDetailed({ id });
              if (stored.outcome === "found" && stored.record.status === "pending") {
                await rpcReq(reviewer, "plugin.approval.resolve", { id, decision: "deny" }).catch(
                  () => {},
                );
              }
            }
          }
        }
        await Promise.all(pending);
        await relay?.drain();
        reviewer?.terminate();
        await gateway?.server.close();
        await Promise.all(handlers);
        observation.mockRestore();
        signal.removeEventListener("abort", releaseResponses);
      }
    },
  );

  it("cancels a disconnected callback without revoking the relay or keeping its late approval", async ({
    signal,
  }) => {
    const entered = createDeferredCore<AbortSignal | undefined>();
    const release = createDeferredCore();
    const cancelled = createDeferredCore();
    const onResolution = vi.fn(() => cancelled.resolve());
    let gateway: GatewayHarness | undefined;
    let relay: ReturnType<typeof registerOwnedNativeHookRelay> | undefined;
    const clients: WebSocket[] = [];
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback" },
      });
      await gateway.server.startupSettled;
      relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "native-ws-disconnect",
        runId: "native-ws-disconnect",
        runBeforeToolCall: async ({ signal: invocationSignal }) => {
          entered.resolve(invocationSignal);
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
      const requester = await gateway.openWs();
      clients.push(requester);
      await connectOk(requester, { scopes: ["operator.admin"] });
      const params = {
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_input: {}, tool_use_id: "disconnected-call" },
      };
      requester.send(
        JSON.stringify({
          type: "req",
          id: "native-callback",
          method: "nativeHook.invoke",
          params,
        }),
      );
      const invocationSignal = await racePromiseWithAbortSignal(entered.promise, signal);
      expect(invocationSignal).toBeDefined();
      const disconnected = once(requester, "close");
      requester.close();
      await disconnected;
      await vi.waitFor(() => expect(invocationSignal?.aborted).toBe(true));
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
      release.resolve();
      await racePromiseWithAbortSignal(cancelled.promise, signal);
      expect(onResolution).toHaveBeenCalledExactlyOnceWith("cancelled");
      expect(
        nativeHookRelayState.pendingPreToolUseApprovals.has(
          JSON.stringify([relay.relayId, "disconnected-call"]),
        ),
      ).toBe(false);

      const next = await gateway.openWs();
      clients.push(next);
      await connectOk(next, { scopes: ["operator.admin"] });
      const result = await rpcReq(next, "nativeHook.invoke", {
        ...params,
        event: "post_tool_use",
        rawPayload: { tool_name: "Bash", tool_input: {}, tool_response: { output: "ok" } },
      });
      expect(result).toMatchObject({ ok: true, payload: { stdout: "", stderr: "", exitCode: 0 } });
      expect((await rpcReq(next, "health", {})).ok).toBe(true);
    } finally {
      unblock();
      relay?.unregister();
      await relay?.drain();
      for (const ws of clients) {
        ws.terminate();
      }
      await gateway?.server.close();
      signal.removeEventListener("abort", unblock);
    }
  });
});
