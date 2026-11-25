import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCodexAbortTranscriptTestFixture } from "../../extensions/codex/test-api.js";
import { createOperationalRunInstanceRef } from "../../src/agents/admitted-run-context.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../src/config/sessions/session-accessor.js";
import { dispatchAgentRunFromGateway } from "../../src/gateway/agent-turn/agent-run-dispatch.js";
import { createTrackedDispatch } from "../../src/gateway/agent-turn/agent-run-dispatch.test-support.js";
import { registerChatAbortController } from "../../src/gateway/chat-abort.js";
import { handleChatAbortRequest } from "../../src/gateway/server-methods/chat-abort-handler.js";
import { ABORTED_PARTIAL_PERSISTENCE_WARNING } from "../../src/gateway/server-methods/chat-aborted-partial.js";
import {
  createAbortTestRunState,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../src/gateway/server-methods/chat.abort.test-helpers.js";
import { claimAgentRunDelegatedAuthority } from "../../src/infra/agent-run-registry.js";
import { withSessionTurn } from "../../src/sessions/session-controller.admission.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../src/sessions/session-controller.barriers.js";
import { createReplyOperation } from "../../src/sessions/session-controller.js";
import { captureSessionTarget } from "../../src/sessions/session-controller.lifecycle.js";
import {
  tryClaimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../src/sessions/session-controller.mailbox.js";
import { markReplyOperationExecutionStarted } from "../../src/sessions/session-controller.state.js";
import { AsyncWorkScope } from "../../src/shared/async-work-scope.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const session = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../src/commands/agent.js").agentCommandFromGatewayIngress>(),
  target: undefined as
    | { agentId: string; sessionId: string; sessionKey: string; storePath: string }
    | undefined,
}));

vi.mock("../../src/commands/agent.js", () => ({
  agentCommandFromGatewayIngress: session.command,
}));

vi.mock("../../src/gateway/session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/gateway/session-utils.js")>();
  return {
    ...original,
    loadGatewaySessionEntryReadOnlyInWorker: async () => {
      if (!session.target) {
        throw new Error("Missing abort transcript fixture");
      }
      return {
        cfg: {},
        agentId: session.target.agentId,
        storePath: session.target.storePath,
        canonicalKey: session.target.sessionKey,
        entry: loadSessionEntry(session.target),
      };
    },
  };
});

const { createCodexAbortTranscriptTestHarness } = await loadCodexAbortTranscriptTestFixture();
const fixture = createCodexAbortTranscriptTestHarness();

function isAssistantEvent(
  event: unknown,
): event is Record<string, unknown> & { message: Record<string, unknown> } {
  return (
    isRecord(event) &&
    event.type === "message" &&
    isRecord(event.message) &&
    event.message.role === "assistant"
  );
}

afterEach(() => {
  session.target = undefined;
  session.command.mockReset();
});

describe("chat.abort native transcript settlement", () => {
  it.each(
    [
      ...(["chat", "agent"] as const).flatMap((owner) =>
        [true, false].map((hasNativeText) => ({ owner, hasNativeText })),
      ),
      {
        owner: "agent" as const,
        hasNativeText: true,
        nativeFirst: true,
      },
      ...[false, true].map((warningDeliveryFails) => ({
        owner: "agent" as const,
        hasNativeText: false,
        superseded: true,
        warningDeliveryFails,
      })),
    ].flatMap((test) =>
      (["run", "session"] as const).map((stopScope) =>
        Object.assign(
          { nativeFirst: false, superseded: false, warningDeliveryFails: false, stopScope },
          test,
        ),
      ),
    ),
  )(
    "settles Stop history ($owner, scope=$stopScope, native text=$hasNativeText, native first=$nativeFirst, superseded=$superseded, warning delivery fails=$warningDeliveryFails)",
    async ({ owner, stopScope, hasNativeText, nativeFirst, superseded, warningDeliveryFails }) => {
      await withOpenClawTestState({ label: "chat-abort-codex" }, async () => {
        const target = await fixture.createTarget();
        session.target = target;
        const text = "Partial response — café 雪 🦞";
        const nativeText = nativeFirst ? `${text} completed` : text;
        const runId = "run-stopped";
        const turnId = "turn-stopped";
        const native = await fixture.createTurn(target, {
          runId,
          turnId,
          text: hasNativeText ? nativeText : "",
        });
        const failures = new Set<unknown>();
        const execution = new AsyncWorkScope(failures);
        const dispatchContext = {
          ...createTrackedDispatch().context,
          chatRunState: createAbortTestRunState([[runId, { buffer: text }]]),
          trackExecution: <T>(run: () => T | Promise<T>) => execution.track(run),
        };
        const context = createChatAbortContext(dispatchContext);
        // Failed warning delivery must release the superseded producer too.
        if (superseded && warningDeliveryFails) {
          vi.mocked(context.broadcast).mockImplementation((event, payload) => {
            if (event === "chat" && isRecord(payload) && payload.state === "error") {
              throw new Error("Synthetic warning transport failure");
            }
          });
        }
        const operationalRunInstance = createOperationalRunInstanceRef(runId);
        const controllerTarget = captureSessionTarget({
          ...target,
          storeScope: target.storePath,
          incarnation: target.sessionId,
        });
        const registration = registerChatAbortController({
          target: controllerTarget,
          runId,
          ...target,
          timeoutMs: 30_000,
          kind: owner === "agent" ? "agent" : "chat-send",
          operationalRunInstance,
          resolveTerminalProducer: (active) => {
            const operation = active.input.claim?.operation;
            return operation
              ? resolveActiveReplyRunOwnerForSignal(operation.abortSignal)
              : undefined;
          },
        });
        const input = expectDefined(registration.entry, "registered source").input;
        registration.initializeTiming();
        const chatClaim =
          owner === "chat"
            ? expectDefined(tryClaimSessionControllerTask(input), "chat claim")
            : undefined;
        const operation =
          owner === "chat"
            ? createReplyOperation({
                ...target,
                target: controllerTarget,
                mailboxClaim: chatClaim,
                resetTriggered: false,
                upstreamAbortSignal: registration.controller.signal,
              })
            : undefined;
        const delivery = createDeferredCore();
        const nativeRelease = createDeferredCore();
        const nativeCompletion = nativeRelease.promise.then(() => native.finish(true));
        const readyForDelivery = createDeferredCore();
        const executionStarted = createDeferredCore();
        session.command.mockImplementationOnce(async (options) => {
          registration.bindAgentRunDelegatedAuthority(
            claimAgentRunDelegatedAuthority(operationalRunInstance),
          );
          expect(registration.markExecutionStarted()).toBe(true);
          executionStarted.resolve();
          await nativeCompletion;
          if (superseded) {
            const entry = loadSessionEntry(target);
            if (!entry) {
              throw new Error("Missing native session before successor claim");
            }
            await replaceSessionEntry(target, { ...entry, activeWriterRunId: "run-successor" });
          }
          await options.beforeTerminalDelivery?.();
          readyForDelivery.resolve();
          await delivery.promise;
          return { payloads: [], meta: { durationMs: 0, aborted: true } };
        });
        const completion = operation
          ? operation.ownerSettlement.then(async () => {
              if (chatClaim) {
                releaseSessionControllerClaim(chatClaim);
                await chatClaim.settlement.promise;
              }
            })
          : withSessionTurn(
              {
                ...target,
                target: controllerTarget,
                controllerInput: input,
                abortSignal: registration.controller.signal,
              },
              async (admitted) => {
                if (!admitted) {
                  throw new Error("expected admitted agent turn");
                }
                markReplyOperationExecutionStarted(admitted);
                admitted.setPhase("running");
                return await dispatchAgentRunFromGateway({
                  admittedRunEntry: registration.entry,
                  ingressOpts: {
                    message: "Synthetic native abort",
                    ...target,
                    allowModelOverride: false,
                    abortSignal: registration.controller.signal,
                  },
                  runId,
                  dedupeKeys: [],
                  abortController: registration.controller,
                  cleanupAbortController: registration.cleanup,
                  io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
                  context: dispatchContext,
                });
              },
            );
        let deliverySettled = false;
        void completion?.then(() => {
          deliverySettled = true;
        });
        const cancel = vi.fn();
        operation?.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
        operation?.setPhase("running");
        if (operation) {
          markReplyOperationExecutionStarted(operation);
        }
        try {
          if (!operation) {
            await Promise.race([executionStarted.promise, completion]);
            expect(session.command).toHaveBeenCalledOnce();
          }
          if (nativeFirst) {
            nativeRelease.resolve();
            await readyForDelivery.promise;
          }
          // A native hook may await this response before its terminal writer can finish.
          const respond = await invokeChatAbortHandler({
            handler: handleChatAbortRequest,
            context,
            request: { sessionKey: target.sessionKey, ...(stopScope === "run" ? { runId } : {}) },
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ aborted: true, runIds: [runId] }),
          );
          expect(registration.controller.signal.aborted).toBe(true);
          expect(input.claim?.released).toBe(false);
          if (operation) {
            expect(cancel).toHaveBeenCalledWith("user_abort");
          }

          nativeRelease.resolve();
          const mirrored = await nativeCompletion;
          operation?.completeWithAfterClearBarrier(delivery.promise);
          await execution.runWhenIdle(() => undefined);
          if (!operation) {
            await readyForDelivery.promise;
          }

          expect(deliverySettled).toBe(false);
          expect(failures).toEqual(new Set());
          const messages = (await loadTranscriptEvents(target)).filter(isAssistantEvent);
          if (superseded) {
            expect(mirrored.assistantTranscriptOwned).toBe(false);
            expect(messages).toHaveLength(0);
            expect(context.broadcast).toHaveBeenCalledWith(
              "chat",
              expect.objectContaining({
                runId,
                state: "error",
                errorMessage: ABORTED_PARTIAL_PERSISTENCE_WARNING,
              }),
              expect.anything(),
            );
            expect(loadSessionEntry(target)?.activeWriterRunId).toBe("run-successor");
            const warning = expect(context.logGateway.warn);
            (warningDeliveryFails ? warning : warning.not).toHaveBeenCalledWith(
              expect.stringContaining("persistence warning delivery failed"),
            );
            return;
          }
          expect(messages).toHaveLength(1);
          if (hasNativeText) {
            const nativeKey = `codex-app-server:${native.threadId}:${turnId}:assistant`;
            expect(mirrored).toMatchObject({
              assistantTranscriptOwned: true,
              assistantTranscriptIdempotencyKey: nativeKey,
              terminalAnchor: {
                agentId: target.agentId,
                sessionId: target.sessionId,
                sessionKey: target.sessionKey,
                storePath: target.storePath,
                entryId: messages[0]?.id,
                rawSeq: expect.any(Number),
                idempotencyKey: nativeKey,
              },
            });
            expect(messages[0]).toMatchObject({
              id: mirrored.terminalAnchor?.entryId,
              message: {
                content: [{ type: "text", text: nativeText }],
                stopReason: "aborted",
                idempotencyKey: nativeKey,
                __openclaw: {
                  mirrorIdentity: `${turnId}:assistant`,
                  mirrorOrigin: "codex-app-server",
                  mirrorSourceFingerprint: expect.any(String),
                  runId,
                  runTerminal: true,
                },
              },
            });
            expect(messages[0]?.message).not.toHaveProperty("openclawAbort");
          } else {
            expect(mirrored.assistantTranscriptOwned).toBe(false);
            expect(messages[0]).toMatchObject({
              message: {
                content: [{ type: "text", text }],
                idempotencyKey: `${runId}:assistant`,
                openclawAbort: { aborted: true, origin: "rpc", runId },
                __openclaw: { runId },
              },
            });
          }

          delivery.resolve();
          await completion;
          const successor = await fixture.createTurn(target, {
            runId: "run-successor",
            turnId: "turn-successor",
            text: nativeText,
          });
          const next = await successor.finish(false);
          expect(next.assistantTranscriptOwned).toBe(true);
          expect(next.terminalAnchor?.entryId).not.toBe(mirrored.terminalAnchor?.entryId);
          const afterSuccessor = (await loadTranscriptEvents(target)).filter(isAssistantEvent);
          expect(afterSuccessor).toHaveLength(2);
          expect(afterSuccessor[1]?.message).toMatchObject({
            content: [{ type: "text", text: nativeText }],
            __openclaw: { runId: "run-successor", runTerminal: true },
          });
        } finally {
          nativeRelease.resolve();
          delivery.resolve();
          operation?.complete();
          await completion;
          await nativeCompletion;
          await execution.drain();
          registration.cleanup();
        }
      });
    },
  );
});
