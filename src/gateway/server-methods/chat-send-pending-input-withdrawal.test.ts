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
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  isRpcSourceQueued,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

type FollowupFixture = Awaited<ReturnType<typeof createBrowserFollowupFixture>>;

async function startInput() {
  const fixture = await createBrowserFollowupFixture();
  const cleanup = async () => {
    clearFollowupQueue(fixture.scope.sessionKey);
    await fixture.cleanup();
  };
  try {
    await fixture.send();
    const recorder = await fixture.dispatchedRecorder;
    const runId = fixture.params.idempotencyKey;
    const active = rpcSourceTesting.get(runId);
    if (!active) {
      throw new Error("Expected the pending input's abort owner");
    }
    return {
      ...fixture,
      recorder,
      active,
      runId,
      [Symbol.asyncDispose]: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function enqueueInput(fixture: FollowupFixture, source: RpcSourceRef) {
  const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
    | Parameters<typeof dispatchInboundMessage>[0]
    | undefined;
  const run = createQueueTestRun({ prompt: fixture.params.message });
  run.abortSignal = source.input.abortSignal;
  run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
  bindSessionControllerSource(source.input, run);
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
  return run;
}

async function discardInput(
  fixture: FollowupFixture,
  respond = vi.fn<RespondFn>(),
  hasCurrentClientAuthority?: () => boolean,
) {
  const params = {
    sessionKey: fixture.scope.sessionKey,
    runId: fixture.params.idempotencyKey,
    discardPendingInput: true,
  };
  await handleChatAbortRequest({
    params,
    req: { type: "req", id: "discard-input", method: "chat.abort", params },
    client: fixture.client,
    context: fixture.context,
    respond,
    isWebchatConnect: () => true,
    hasCurrentClientAuthority,
  });
  return respond;
}

describe("queued chat input withdrawal", () => {
  it("keeps refused browser input revoked after its session access returns", async () => {
    await using fixture = await createBrowserFollowupFixture({
      preserveContent: true,
      persistDuringDispatch: true,
    });
    const profile = ensureProfileForEmail("restored-custody@example.test");
    setClientProfile(fixture.client, profile);
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
      cause: {
        message: expect.stringContaining("session is draft for this connection"),
      },
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
  });

  it.each([
    ["admitted", "timeout", "timeout", false],
    ["queued", "stop", "stop", false],
    ["queued", "restart", "restart", false],
    ["signal", undefined, "aborted", false],
    ["consumed", "rpc", undefined, false],
    ["queued", "rpc", "rpc", true],
  ] as const)(
    "settles %s input (%s, %s, discard: %s) without losing recovery",
    async (target, stopReason, reason, discardPendingInput) => {
      await using fixture = await startInput();
      const { context, scope, active, recorder, runId } = fixture;
      if (target === "queued") {
        enqueueInput(fixture, active);
        const detached = createDeferred();
        vi.mocked(fixture.context.removeChatRun).mockImplementationOnce(() => {
          detached.resolve();
          return undefined;
        });
        // Release ingress only; the predecessor still owns the running turn.
        fixture.releaseDispatch();
        await detached.promise;
        expect(rpcSourceTesting.get(runId)).toBe(active);
        expect(isRpcSourceQueued(active)).toBe(true);
      }
      if (target === "signal") {
        requestRpcSourceCancellation(
          active,
          new Error("Private cancellation payload must stay out of logs"),
        );
      } else {
        if (target === "consumed") {
          await recorder.persistApproved();
        }
        if (discardPendingInput) {
          expect(await discardInput(fixture)).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [runId],
          });
        } else {
          const params = { runId, sessionKey: scope.sessionKey, stopReason };
          const result = abortChatRunById(createChatAbortOps(context), params);
          expect(result.aborted).toBe(true);
        }
      }
      await fixture.finishDispatch();
      const disposition = reason === "restart" ? "interrupted" : "cancelled";
      const prefix = "chat pending input aborted:";
      const logs = vi
        .mocked(context.logGateway.info)
        .mock.calls.filter(([message]) => message.startsWith(prefix));
      const { sessionKey, sessionId } = scope;
      const details = { runId, sessionKey, sessionId, agentId: "main", disposition, reason };
      expect(logs).toEqual(reason ? [[`${prefix} ${reason} (${disposition})`, details]] : []);
      expect(await listSessionPendingInputs(scope)).toMatchObject(
        reason ? { items: [{ state: disposition }], total: 1 } : { items: [], total: 0 },
      );
      if (reason) {
        const page = await readChatPendingInputs(scope, { limit: 1, maxChars: 1000 });
        expect(page.items).toHaveLength(1);
        if (discardPendingInput) {
          expect(page.items[0]?.message).toMatchObject({ display: false, content: [] });
          expect(JSON.stringify(page)).not.toContain(fixture.approvedContent);
        } else {
          expect(page.items[0]?.message).toMatchObject({ content: fixture.approvedContent });
        }
        expect(await listSessionPendingInputReceipts(scope, { runIds: [runId] })).toEqual([
          {
            runId,
            state: "pending",
            ...(disposition === "cancelled" ? { cancelled: true } : {}),
          },
        ]);
        expect(loadTranscriptEventsSync(scope)).toEqual(fixture.activeTranscript);
      } else {
        expect(JSON.stringify(loadTranscriptEventsSync(scope))).toContain(fixture.approvedContent);
      }
    },
  );

  it.each(["claimed", "consumed", "queued-consumed"] as const)(
    "does not stop an input that cannot be removed ($0)",
    async (target) => {
      await using fixture = await startInput();
      const { recorder, runId, active, scope } = fixture;
      let claimed: Awaited<ReturnType<typeof claimSessionControllerInput>> | undefined;
      try {
        if (target === "queued-consumed") {
          enqueueInput(fixture, active);
        }
        if (target === "claimed") {
          fixture.activeRun?.complete();
          const run = createQueueTestRun({ prompt: fixture.params.message });
          bindSessionControllerSource(active.input, run);
          claimed = await claimSessionControllerInput(run);
        } else {
          await recorder.persistApproved();
        }
        const queuedBefore = isRpcSourceQueued(active);
        const pending = await listSessionPendingInputs(scope);
        const transcript = loadTranscriptEventsSync(scope);
        const respond = await discardInput(fixture);

        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
        expect(active.input.abortSignal.aborted).toBe(false);
        expect(rpcSourceTesting.get(runId)).toBe(active);
        expect(isRpcSourceQueued(active)).toBe(queuedBefore);
        expect(await listSessionPendingInputs(scope)).toEqual(pending);
        expect(loadTranscriptEventsSync(scope)).toEqual(transcript);
      } finally {
        if (claimed) {
          releaseSessionControllerClaim(claimed);
        }
      }
    },
  );

  it.each(["retry", "resume", "retired", "revoked"] as const)(
    "keeps refused removal available for $0 and fences adoption through withdrawal commit",
    async (afterRefusal) => {
      await using fixture = await startInput();
      const { runId, active, scope } = fixture;
      const { sessionKey, sessionId, agentId } = scope;
      let unsubscribe: (() => void) | undefined;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const refusal = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
      let replacement: RpcSourceRef | undefined;
      let cleanupReplacement: (() => void) | undefined;
      let retiredAfterCommit = false;
      const published: Promise<boolean>[] = [];
      try {
        const run = enqueueInput(fixture, active);
        expect(isRpcSourceQueued(active)).toBe(true);
        let adoption: Promise<"admitted" | "aborted"> | undefined;
        const beginAdoption = () => {
          adoption = claimSessionControllerInput(run)
            .then(async (claim) => {
              try {
                await admitFollowupRunLifecycle(run);
                retireFollowupRunCancellation(run);
              } finally {
                releaseSessionControllerClaim(claim);
              }
            })
            .then(
              () => "admitted" as const,
              () => "aborted" as const,
            );
          fixture.activeRun?.complete();
        };
        let requestCurrent = true;
        unsubscribe = sessionChanges.subscribe((change) => {
          if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
            const publication = listSessionPendingInputs(scope).then(({ items }) => {
              const input = items[0];
              return input?.state === "cancelled" && input.message.display === false;
            });
            void publication.catch(() => {});
            published.push(publication);
            // Revoke at publication; awaiting the read would miss this synchronous race.
            if (afterRefusal === "retired" && !replacement) {
              rpcSourceTesting.delete(runId);
              const registration = registerChatAbortController({
                runId,
                ...scope,
                target: captureSessionTarget({
                  storeScope: scope.storePath,
                  sessionKey,
                  incarnation: sessionId,
                  agentId,
                }),
                timeoutMs: 60_000,
              });
              replacement = registration.entry;
              cleanupReplacement = registration.cleanup;
              retiredAfterCommit = rpcSourceTesting.get(runId) !== active;
            }
            if (afterRefusal === "revoked") {
              requestCurrent = false;
            }
          }
        });
        const respond = vi.fn<RespondFn>();
        const remove = () => discardInput(fixture, respond, () => requestCurrent);

        let refuseCommit = true;
        refusal.mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              if (!refuseCommit || afterRefusal === "resume") {
                beginAdoption();
              }
              if (refuseCommit) {
                throw new Error("Synthetic withdrawal commit refusal");
              }
            }
            return callback(request, grant);
          }, attachment),
        );
        await expect(remove()).rejects.toThrow("Synthetic withdrawal commit refusal");
        expect(rpcSourceTesting.get(runId)).toBe(active);
        if (afterRefusal !== "resume") {
          expect(isRpcSourceQueued(active)).toBe(true);
        }
        expect(active.input.abortSignal.aborted).toBe(false);
        expect((await listSessionPendingInputs(scope)).items[0]?.state).toBe("queued");
        expect(published).toEqual([]);

        if (afterRefusal === "resume") {
          await expect(adoption).resolves.toBe("admitted");
          return;
        }
        refuseCommit = false;
        await remove();
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [runId] });
        await expect(adoption).resolves.toBe("aborted");
        expect(active.input.abortSignal.aborted).toBe(true);
        if (afterRefusal === "retired") {
          expect(retiredAfterCommit).toBe(true);
          expect(replacement).toBeDefined();
        }
        if (replacement) {
          expect(replacement.input.abortSignal.aborted).toBe(false);
          expect(rpcSourceTesting.get(runId)).toBe(replacement);
        }
        expect(published.length).toBeGreaterThan(0);
        for (const result of await Promise.allSettled(published)) {
          expect(result).toEqual({ status: "fulfilled", value: true });
        }
        expect(loadTranscriptEventsSync(scope)).toEqual(fixture.activeTranscript);
      } finally {
        refusal.mockRestore();
        unsubscribe?.();
        await Promise.allSettled(published);
        cleanupReplacement?.();
      }
    },
  );
});
