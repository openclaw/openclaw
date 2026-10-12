import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  admitFollowupRunLifecycle,
  retireFollowupRunCancellation,
} from "../../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readSessionPendingInputReceiptsInWorker as listSessionPendingInputReceipts } from "../../config/sessions/session-pending-input-receipts.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, removeChatAbortControllerEntry } from "../chat-abort.js";
import { abortQueuedChatTurnById } from "../chat-queued-turns.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import * as sessionChangeEvent from "./session-change-event.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("queued chat input withdrawal", () => {
  it("keeps refused browser input revoked after its session access returns", async () => {
    const fixture = await createBrowserFollowupFixture({
      preserveContent: true,
      persistDuringDispatch: true,
    });
    try {
      const profile = ensureProfileForEmail("restored-custody@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      fixture.client.connect.scopes = ["operator.read", "operator.write"];
      const ack = await fixture.send(undefined, { expectedProfileId: profile.id });
      const recorder = await fixture.dispatchedRecorder;
      const check = () =>
        recorder.withPendingInputCurrent
          ? recorder.withPendingInputCurrent(() => {})
          : Promise.resolve().then(() => recorder.withPendingInput?.(() => {}));
      await patchSessionEntryCore(fixture.scope, () => ({ visibility: "draft" }));
      await expect(check()).rejects.toMatchObject({
        message: "Message injection authority is no longer current",
        cause: expect.objectContaining({
          message: expect.stringContaining("session is draft for this connection"),
        }),
      });
      await patchSessionEntryCore(fixture.scope, () => ({ visibility: "shared" }));
      await expect(check()).rejects.toThrow("Message injection authority is no longer current");
      await fixture.finishDispatch();
      expect(ack).toHaveBeenCalledOnce();
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      expect(recorder.getAdmissionReceipt()).toBeUndefined();
      expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "interrupted" }],
      });
      expect(loadTranscriptEventsSync(fixture.scope)).not.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            idempotencyKey: `${fixture.params.idempotencyKey}:user`,
          }),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { target: "admitted", stopReason: "timeout", reason: "timeout", discardPendingInput: false },
    { target: "queued", stopReason: "stop", reason: "stop", discardPendingInput: false },
    { target: "queued", stopReason: "restart", reason: "restart", discardPendingInput: false },
    { target: "signal", stopReason: undefined, reason: "aborted", discardPendingInput: false },
    { target: "consumed", stopReason: "rpc", reason: undefined, discardPendingInput: false },
    { target: "queued", stopReason: "rpc", reason: "rpc", discardPendingInput: true },
  ] as const)(
    "settles $target input ($stopReason, discard: $discardPendingInput) without losing recovery",
    async ({ target, stopReason, reason, discardPendingInput }) => {
      const fixture = await createBrowserFollowupFixture();
      let dispatchCompletion: Promise<void> | undefined;
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        const runId = fixture.params.idempotencyKey;
        const active = fixture.context.chatAbortControllers.get(runId);
        if (!active) {
          throw new Error("Expected the pending input's abort owner");
        }
        const discard = async () => {
          const params = { sessionKey: fixture.scope.sessionKey, runId, discardPendingInput: true };
          const respond = vi.fn<RespondFn>();
          await handleChatAbortRequest({
            params,
            req: { type: "req", id: "discard-input", method: "chat.abort", params },
            client: fixture.client,
            context: fixture.context,
            respond,
            isWebchatConnect: () => true,
          });
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [runId],
          });
        };
        if (target === "queued") {
          const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
            | Parameters<typeof dispatchInboundMessage>[0]
            | undefined;
          const run = createQueueTestRun({ prompt: fixture.params.message });
          run.abortSignal = active.controller.signal;
          run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
          expect(run.turnAdoptionLifecycle).toBeDefined();
          expect(
            enqueueFollowupRun(
              fixture.scope.sessionKey,
              run,
              createQueueSettings({ mode: "followup" }),
              "none",
              async () => {},
              false,
            ),
          ).toBe(true);
          const detached = createDeferred();
          vi.mocked(fixture.context.removeChatRun).mockImplementationOnce(() => {
            detached.resolve();
            return undefined;
          });
          dispatchCompletion = fixture.finishDispatch();
          await detached.promise;
          expect(fixture.context.chatAbortControllers.has(runId)).toBe(false);
          expect(fixture.context.chatQueuedTurns.has(runId)).toBe(true);
          if (discardPendingInput) {
            await discard();
          } else {
            expect(
              abortQueuedChatTurnById(fixture.context.chatQueuedTurns, {
                runId,
                sessionKey: fixture.scope.sessionKey,
                stopReason,
              }).aborted,
            ).toBe(true);
          }
        } else if (target === "signal") {
          active.controller.abort(new Error("Private cancellation payload must stay out of logs"));
        } else {
          if (target === "consumed") {
            await recorder.persistApproved();
          }
          if (discardPendingInput) {
            await discard();
          } else {
            expect(
              abortChatRunById(createChatAbortOps(fixture.context), {
                runId,
                sessionKey: fixture.scope.sessionKey,
                stopReason,
              }).aborted,
            ).toBe(true);
          }
        }
        await (dispatchCompletion ?? fixture.finishDispatch());
        const disposition = reason === "restart" ? "interrupted" : "cancelled";
        expect(
          vi
            .mocked(fixture.context.logGateway.info)
            .mock.calls.filter(([message]) => message.startsWith("chat pending input aborted:")),
        ).toEqual(
          reason
            ? [
                [
                  `chat pending input aborted: ${reason} (${disposition})`,
                  {
                    runId,
                    sessionKey: fixture.scope.sessionKey,
                    sessionId: fixture.scope.sessionId,
                    agentId: "main",
                    disposition,
                    reason,
                  },
                ],
              ]
            : [],
        );
        expect(await listSessionPendingInputs(fixture.scope)).toMatchObject(
          reason ? { items: [{ state: disposition }], total: 1 } : { items: [], total: 0 },
        );
        if (reason) {
          const page = await readChatPendingInputs(fixture.scope, { limit: 1, maxChars: 1000 });
          expect(page.items).toHaveLength(1);
          if (discardPendingInput) {
            expect(page.items[0]?.message).toMatchObject({ display: false, content: [] });
            expect(JSON.stringify(page)).not.toContain(fixture.approvedContent);
          } else {
            expect(page.items[0]?.message).toMatchObject({ content: fixture.approvedContent });
          }
          expect(await listSessionPendingInputReceipts(fixture.scope, { runIds: [runId] })).toEqual(
            [
              {
                runId,
                state: "pending",
                ...(disposition === "cancelled" ? { cancelled: true } : {}),
              },
            ],
          );
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        } else {
          expect(JSON.stringify(loadTranscriptEventsSync(fixture.scope))).toContain(
            fixture.approvedContent,
          );
        }
      } finally {
        clearFollowupQueue(fixture.scope.sessionKey);
        await fixture.cleanup();
      }
    },
  );

  it.each(["admitted", "consumed", "queued-consumed"] as const)(
    "does not stop an input that cannot be removed ($0)",
    async (target) => {
      const fixture = await createBrowserFollowupFixture();
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        const runId = fixture.params.idempotencyKey;
        const active = fixture.context.chatAbortControllers.get(runId);
        if (!active) {
          throw new Error("Expected the pending input's abort owner");
        }
        if (target === "queued-consumed") {
          const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
            | Parameters<typeof dispatchInboundMessage>[0]
            | undefined;
          const run = createQueueTestRun({ prompt: fixture.params.message });
          run.abortSignal = active.controller.signal;
          run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
          expect(
            enqueueFollowupRun(
              fixture.scope.sessionKey,
              run,
              createQueueSettings({ mode: "followup" }),
              "none",
              async () => {},
              false,
            ),
          ).toBe(true);
        }
        if (target !== "admitted") {
          await recorder.persistApproved();
        }
        const queued = fixture.context.chatQueuedTurns.get(runId);
        const pending = await listSessionPendingInputs(fixture.scope);
        const transcript = loadTranscriptEventsSync(fixture.scope);
        const params = { sessionKey: fixture.scope.sessionKey, runId, discardPendingInput: true };
        const respond = vi.fn<RespondFn>();

        await handleChatAbortRequest({
          params,
          req: { type: "req", id: "stale-removal", method: "chat.abort", params },
          client: fixture.client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => true,
        });

        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
        expect(active.controller.signal.aborted).toBe(false);
        expect(fixture.context.chatAbortControllers.get(runId)).toBe(active);
        expect(fixture.context.chatQueuedTurns.get(runId)).toBe(queued);
        expect(await listSessionPendingInputs(fixture.scope)).toEqual(pending);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
      } finally {
        clearFollowupQueue(fixture.scope.sessionKey);
        await fixture.cleanup();
      }
    },
  );

  it.each(["retry", "resume", "retired", "revoked"] as const)(
    "keeps refused removal available for $0 and fences adoption through withdrawal commit",
    async (afterRefusal) => {
      const fixture = await createBrowserFollowupFixture();
      let unsubscribe: (() => void) | undefined;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const refusal = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
      const publishChange = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
      let replacementController: AbortController | undefined;
      let retiredAfterCommit = false;
      const published: Promise<PromiseSettledResult<boolean>>[] = [];
      try {
        await fixture.send();
        await fixture.dispatchedRecorder;
        const runId = fixture.params.idempotencyKey;
        const active = fixture.context.chatAbortControllers.get(runId);
        if (!active) {
          throw new Error("Expected the pending input's abort owner");
        }
        const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
          | Parameters<typeof dispatchInboundMessage>[0]
          | undefined;
        const run = createQueueTestRun({ prompt: fixture.params.message });
        run.abortSignal = active.controller.signal;
        run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
        expect(
          enqueueFollowupRun(
            fixture.scope.sessionKey,
            run,
            createQueueSettings({ mode: "followup" }),
            "none",
            async () => {},
            false,
          ),
        ).toBe(true);
        const queued = fixture.context.chatQueuedTurns.get(runId);
        expect(queued).toBeDefined();
        let adoption: Promise<"admitted" | "aborted"> | undefined;
        const beginAdoption = () => {
          adoption = admitFollowupRunLifecycle(run).then(
            () => {
              retireFollowupRunCancellation(run);
              return "admitted" as const;
            },
            () => "aborted" as const,
          );
        };
        let requestCurrent = true;
        unsubscribe = sessionChanges.subscribe((change) => {
          if ("sessionKey" in change && change.sessionKey === fixture.scope.sessionKey) {
            published.push(
              Promise.allSettled([
                listSessionPendingInputs(fixture.scope).then(({ items }) => {
                  const input = items[0];
                  return input?.state === "cancelled" && input.message.display === false;
                }),
              ]).then(([result]) => result),
            );
            // Revoke at publication; awaiting the read would miss this synchronous race.
            if (afterRefusal === "retired" && !replacementController) {
              const replacement = createActiveRun(fixture.scope.sessionKey, {
                agentId: fixture.scope.agentId,
                sessionId: fixture.scope.sessionId,
              });
              replacementController = replacement.controller;
              retiredAfterCommit = removeChatAbortControllerEntry(
                fixture.context.chatAbortControllers,
                runId,
                active,
              );
              fixture.context.chatAbortControllers.set(runId, replacement);
            }
            if (afterRefusal === "revoked") {
              requestCurrent = false;
            }
          }
        });
        const params = { sessionKey: fixture.scope.sessionKey, runId, discardPendingInput: true };
        const respond = vi.fn<RespondFn>();
        const remove = () =>
          handleChatAbortRequest({
            params,
            req: { type: "req", id: "retry-removal", method: "chat.abort", params },
            client: fixture.client,
            context: fixture.context,
            respond,
            isWebchatConnect: () => true,
            hasCurrentClientAuthority: () => requestCurrent,
          });

        refusal.mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              if (afterRefusal === "resume") {
                beginAdoption();
              }
              throw new Error("Synthetic withdrawal commit refusal");
            }
            return callback(request, grant);
          }, attachment),
        );
        await expect(remove()).rejects.toThrow("Synthetic withdrawal commit refusal");
        expect(fixture.context.chatAbortControllers.get(runId)).toBe(active);
        expect(fixture.context.chatQueuedTurns.get(runId)).toBe(queued);
        expect(active.controller.signal.aborted).toBe(false);
        expect((await listSessionPendingInputs(fixture.scope)).items[0]?.state).toBe("queued");
        expect(published).toEqual([]);

        if (afterRefusal === "resume") {
          await expect(adoption).resolves.toBe("admitted");
          return;
        }
        refusal.mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              beginAdoption();
            }
            return callback(request, grant);
          }, attachment),
        );
        if (afterRefusal === "revoked") {
          await expect(remove()).rejects.toThrow("Gateway requester authority changed");
        } else {
          await remove();
          expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [runId] });
        }
        await expect(adoption).resolves.toBe("aborted");
        expect(active.controller.signal.aborted).toBe(true);
        if (afterRefusal === "retired") {
          expect(retiredAfterCommit).toBe(true);
          expect(replacementController).toBeDefined();
        }
        if (replacementController) {
          expect(replacementController.signal.aborted).toBe(false);
          expect(fixture.context.chatAbortControllers.get(runId)?.controller).toBe(
            replacementController,
          );
        }
        expect(published.length).toBeGreaterThan(0);
        for (const result of await Promise.all(published)) {
          expect(result).toEqual({ status: "fulfilled", value: true });
        }
        expect(publishChange).toHaveBeenCalledWith(
          fixture.context,
          {
            sessionKey: fixture.scope.sessionKey,
            sessionId: fixture.scope.sessionId,
            agentId: fixture.scope.agentId,
            reason: "agent.input.settled",
          },
          { accessChanged: false },
        );
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      } finally {
        refusal.mockRestore();
        publishChange.mockRestore();
        unsubscribe?.();
        await Promise.allSettled(published);
        const replacement = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
        if (replacement && replacement.controller === replacementController) {
          removeChatAbortControllerEntry(
            fixture.context.chatAbortControllers,
            fixture.params.idempotencyKey,
            replacement,
          );
        }
        clearFollowupQueue(fixture.scope.sessionKey);
        await fixture.cleanup();
      }
    },
  );
});
