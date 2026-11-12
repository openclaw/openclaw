import { assert, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { bindSessionControllerSource } from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { retainGatewayOperatorRun } from "./operator-run-cancellation.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import * as restartResume from "./session-restart-resume.js";

it.for([false, true])(
  "preserves accepted ingress input through real Gateway restart unless its grant is revoked (%s)",
  async (revoke, { signal }) => {
    const fixture = await createGatewayMetadataCloseFixture("gateway-queued-ingress-close");
    const markerEntered = createDeferred();
    const releaseMarker = createDeferred();
    let closing: Promise<unknown> | undefined;
    let pending: Awaited<ReturnType<typeof stageSessionPendingInput>> | undefined;
    let retained: Awaited<ReturnType<typeof retainGatewayOperatorRun>> | undefined;
    let registration: ReturnType<typeof registerChatAbortController> | undefined;
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    const persistMarkers = restartResume.persistRunningSessionsForRestart;
    const markers = vi
      .spyOn(restartResume, "persistRunningSessionsForRestart")
      .mockImplementation(async (params) => {
        markerEntered.resolve();
        await releaseMarker.promise;
        await persistMarkers(params);
      });
    let restoreRegistry: (() => void) | undefined;
    try {
      const { server, kernel } = await fixture.startServer();
      const databasePath = resolveOpenClawAgentSqlitePath({
        agentId: "main",
        env: fixture.state.env,
      });
      const sessionKey = "agent:main:queued-ingress-close";
      const sessionId = "queued-ingress-close-session";
      const scope = { agentId: "main", sessionKey, sessionId, storePath: databasePath };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
      const target = captureSessionTarget({
        agentId: "main",
        sessionKey,
        incarnation: sessionId,
        storeScope: databasePath,
      });
      operation = createReplyOperation({
        sessionKey,
        sessionId,
        agentId: "main",
        resetTriggered: false,
        target,
      });
      operation.setPhase("running");
      bindGatewayContextResolver(operation, kernel.resolvePluginGatewayContext);
      const active = operation;
      active.abortSignal.addEventListener("abort", () => active.complete(), { once: true });
      const runId = "queued-ingress-original-run";
      const message = {
        role: "user" as const,
        content: "Original queued input: ünicode 🦞\nRetain these exact bytes.",
        timestamp: 2,
        idempotencyKey: "queued-ingress-original:user",
      };
      const method = "close-fixture.queue";
      const registry = createGatewayMethodRegistry([
        ...kernel.getAttachedGatewayMethodRegistry().descriptors(),
        {
          name: method,
          owner: { kind: "aux", area: "close-fixture" },
          scope: "operator.write",
          handler: async ({
            client,
            context,
            hasCurrentClientAuthority,
            respond,
          }: GatewayRequestOptions) => {
            registration = registerChatAbortController({
              target,
              sessionKey,
              sessionId,
              agentId: "main",
              runId,
              timeoutMs: 60_000,
              onCancel: () => pending?.finish("cancelled"),
            });
            assert(registration.entry);
            retained = await retainGatewayOperatorRun({
              client,
              context,
              hasCurrentClientAuthority,
              runId,
              entry: registration.entry,
            });
            assert(retained.authority);
            const source = captureQueuedOperatorRecoverySource(retained.authority);
            assert(source?.kind === "gateway");
            pending = await stageSessionPendingInput(scope, {
              runId,
              message,
              recoverySource: source,
              assertCurrent: retained.authority.assertCurrent,
            });
            assert(pending);
            registration.entry.adapter.onSettled = async () => {
              await pending?.settled?.();
              retained?.release();
            };
            const run = createQueueTestRun(
              { prompt: message.content, abortSignal: registration.entry.input.abortSignal },
              { config: kernel.gatewayRequestContext.getRuntimeConfig(), ...scope },
            );
            run.operatorAuthority = retained.authority;
            bindSessionControllerSource(registration.entry.input, run);
            assert(enqueueFollowupRun(sessionKey, run, { mode: "followup" }, "none"));
            retained.armCancellation();
            respond(true, { status: "accepted" });
          },
        },
      ]);
      const registrySpy = vi
        .spyOn(kernel.gatewayRequestContext, "getGatewayMethodRegistry")
        .mockReturnValue(registry);
      restoreRegistry = () => registrySpy.mockRestore();
      const host = getGatewayControlUiIngressHost(kernel.resolvePluginGatewayContext);
      assert(host);
      const factory = createGatewayControlUiIngressFactory({
        pluginId: fixture.pluginId,
        signal: kernel.scheduler.signal,
        assertCurrent: () => kernel.scheduler.signal.throwIfAborted(),
        host,
      });
      const grant = new AbortController();
      const principal = {
        audienceId: "queued-ingress-audience",
        principal: { kind: "owner" as const },
        operatorScopeCeiling: ["operator.read", "operator.write"],
        signal: grant.signal,
        assertCurrent: () => grant.signal.throwIfAborted(),
      };
      await factory.registerPrincipalRecovery?.(async () => ({
        ...principal,
        recoveryId: "queued-ingress-grant",
      }));
      const binding = await factory.bindPrincipal(principal);
      expect(await binding.request(method, {})).toEqual({ status: "accepted" });
      assert(pending && registration?.entry && retained?.authority);
      const inputId = pending.inputId;
      const authority = retained.authority;
      closing = server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 });
      await withinTest(
        awaitGateBeforeSettlement(
          markerEntered.promise,
          closing,
          "Gateway skipped restart markers",
        ),
        signal,
      );
      if (!revoke) {
        expect(() => authority.assertCurrent()).not.toThrow();
        await expect(binding.request(method, {})).rejects.toMatchObject({ name: "AbortError" });
        await expect(factory.bindPrincipal(principal)).rejects.toMatchObject({
          name: "AbortError",
        });
      }
      if (revoke) {
        grant.abort(new Error("Original ingress grant revoked"));
        await withinTest(registration.entry.input.settlement.promise, signal);
      }
      releaseMarker.resolve();
      await withinTest(closing, signal);
      const [session] = readClosedDatabase(
        databasePath,
        "SELECT entry_json FROM session_nodes WHERE session_key = ?",
        sessionKey,
      );
      const marker = JSON.parse(String(session?.entry_json)).resumeAfterRestart;
      expect(marker.queuedInputIds).toEqual(revoke ? [] : [inputId]);
      if (revoke) {
        expect(marker.queuedInputSources).toBeUndefined();
      } else {
        expect(marker.queuedInputSources).toMatchObject({
          [inputId]: {
            runId,
            source: {
              kind: "gateway",
              snapshot: {
                sourceIngress: "principal",
                scopes: ["operator.read", "operator.write"],
                ingress: {
                  pluginId: fixture.pluginId,
                  audienceId: principal.audienceId,
                  recoveryId: "queued-ingress-grant",
                },
              },
            },
          },
        });
      }
      const [stored] = readClosedDatabase(
        databasePath,
        "SELECT state, message_json, run_id FROM session_pending_inputs WHERE input_id = ?",
        inputId,
      );
      expect(stored).toMatchObject({ state: revoke ? "cancelled" : "queued", run_id: runId });
      expect(JSON.parse(String(stored?.message_json))).toMatchObject(message);
    } finally {
      releaseMarker.resolve();
      operation?.complete();
      await Promise.allSettled([closing]);
      retained?.release();
      registration?.cleanup();
      markers.mockRestore();
      restoreRegistry?.();
      await fixture.cleanup();
    }
  },
);
