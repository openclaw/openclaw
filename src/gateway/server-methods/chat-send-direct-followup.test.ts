import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { runWithAgentCommandRecoveryOwner } from "../../agents/agent-command-recovery-owner.js";
import * as runs from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  captureRequesterOrigin,
  hasSameRequesterOrigin,
  resolveRequesterPrincipalKey,
} from "../../agents/requester-origin.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import * as restartRecovery from "../../auto-reply/reply/agent-runner-restart-recovery.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import * as replyRunHelpers from "../../auto-reply/reply/get-reply-run-helpers.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionPendingInputs } from "../../config/sessions/session-pending-input-history.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { createRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import * as runAuthority from "../../infra/agent-run-registry.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { isRpcSourceQueued } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import * as chatReplyMedia from "./chat-reply-media.js";
import { loadRealChatDispatch, successfulChatTurn } from "./chat-send-authority.test-support.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));
vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

it("refuses cross-requester steering by default and admits only an explicit fresh followup", async ({
  signal,
}) => {
  const refusal =
    "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.";
  const fixture = await createFixture({ preserveContent: true });
  const operation = expectDefined(fixture.activeRun, "incumbent reply operation");
  const alice = ensureProfileForEmail("strict-steer-alice@example.test");
  const bob = ensureProfileForEmail("strict-steer-bob@example.test");
  setClientProfile(fixture.client, bob);
  fixture.params.queueMode = "steer";
  fixture.params.idempotencyKey = "strict-steer-bob-input";
  const config = withFullRuntimeReplyConfig(fixture.context.getRuntimeConfig());
  config.messages = {
    ...config.messages,
    queue: {
      mode: "steer",
      debounceMsByChannel: { webchat: 0 },
    },
  };
  setRuntimeConfigSnapshot(config, config);
  fixture.context.getRuntimeConfig = () => config;
  const fingerprint = "strict-steer-incumbent-tools";
  operation.bindToolAuthoritySnapshot({
    requesterPrincipalKey: resolveRequesterPrincipalKey({ operatorProfileId: alice.id }),
    fingerprint: () => fingerprint,
    project: () => fingerprint,
  });
  operation.bindToolAuthorityRoute({ provider: "openai", model: "gpt-test" });
  operation.setPhase("running");
  const injectionObserved = createDeferred();
  const injected = vi.fn(async () => {
    injectionObserved.resolve();
  });
  operation.attachBackend({
    kind: "embedded",
    runId: "strict-steer-alice-run",
    toolAuthorityFingerprint: fingerprint,
    cancel() {},
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: injected },
  });
  const dispatchActual = await loadRealChatDispatch();
  const dispatched = createDeferred();
  const rawQueued = createDeferred();
  const followupId = "strict-steer-bob-explicit-followup";
  const queued = createDeferred();
  const followupDispatched = createDeferred();
  const started = createDeferred();
  const release = createDeferred();
  const settled = createDeferred();
  const consumed: Parameters<typeof executeAgentTurn>[0][] = [];
  runtime.execute.mockReset();
  runtime.execute.mockRejectedValue(new Error("Refused input must not execute"));
  dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
    const params = raw as Parameters<typeof dispatchInboundMessage>[0];
    const isExplicitFollowup = params.replyOptions?.runId === followupId;
    if (isExplicitFollowup) {
      const lifecycle = expectDefined(params.replyOptions?.turnAdoptionLifecycle, "input custody");
      const onDeferred = expectDefined(lifecycle.onDeferred, "queue admission");
      lifecycle.onDeferred = () => {
        const result = onDeferred();
        queued.resolve();
        return result;
      };
      const onSettled = lifecycle.onSettled;
      lifecycle.onSettled = async () => {
        await onSettled?.();
        settled.resolve();
      };
    } else {
      const lifecycle = expectDefined(params.replyOptions?.turnAdoptionLifecycle, "input custody");
      const onDeferred = expectDefined(lifecycle.onDeferred, "queue admission");
      lifecycle.onDeferred = () => {
        const result = onDeferred();
        if (result === true) {
          rawQueued.resolve();
        }
        return result;
      };
    }
    try {
      return await dispatchActual({
        ...params,
        cfg: config,
      });
    } finally {
      (isExplicitFollowup ? followupDispatched : dispatched).resolve();
    }
  });
  try {
    const ack = await fixture.send();
    expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
    await withinTest(
      Promise.race([injectionObserved.promise, rawQueued.promise, dispatched.promise]),
      signal,
    );
    await withinTest(dispatched.promise, signal);
    await rpcSourceTesting.get(fixture.params.idempotencyKey)?.input.settlement.promise;
    expect(injected).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
    expect(isRpcSourceQueued(rpcSourceTesting.get(fixture.params.idempotencyKey))).toBe(false);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(fixture.context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: fixture.params.idempotencyKey,
        state: "final",
        message: expect.objectContaining({
          content: [{ type: "text", text: refusal, openclawStatusNotice: true }],
        }),
      }),
      expect.anything(),
    );
    const pending = await listSessionPendingInputs(fixture.scope);
    expect(pending).toMatchObject({
      total: 1,
      items: [{ runId: fixture.params.idempotencyKey, state: "cancelled" }],
    });
    const duplicate = await fixture.send();
    expect(duplicate.mock.calls[0]?.[0]).toBe(false);
    expect(duplicate.mock.calls[0]?.[1]).toMatchObject({
      status: "error",
      summary: refusal,
    });
    fixture.context.dedupe.clear();
    const durableRetry = await fixture.send();
    expect(durableRetry.mock.calls[0]?.[0]).toBe(false);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(runtime.execute).not.toHaveBeenCalled();
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual(pending.items);

    runtime.execute.mockImplementation(async (params) => {
      const { followupRun, opts } = params;
      const runId = expectDefined(opts?.runId, "followup run ID");
      opts?.onAgentRunStart?.(runId);
      await expectDefined(
        followupRun.userTurnTranscriptRecorder,
        "input recorder",
      ).persistApproved();
      consumed.push(params);
      started.resolve();
      await withinTest(release.promise, signal);
      return successfulChatTurn(runId, "Bob's explicit followup answered.");
    });
    const followupOutcome = createDeferred();
    const broadcast = vi.mocked(fixture.context.broadcast);
    const originalBroadcast = broadcast.getMockImplementation();
    broadcast.mockImplementation((event, payload, opts) => {
      const result = originalBroadcast?.call(fixture.context, event, payload, opts);
      if (
        event === "chat" &&
        isRecord(payload) &&
        payload.runId === followupId &&
        (payload.state === "delta" || payload.state === "final" || payload.state === "error")
      ) {
        followupOutcome.resolve();
      }
      return result;
    });
    config.tools = { ...config.tools, deny: ["write"] };
    setRuntimeConfigSnapshot(config, config);
    fixture.params.idempotencyKey = followupId;
    fixture.params.message = "/followup Answer Bob's separate request.";
    const explicitAck = await fixture.send();
    expect(explicitAck.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
    await withinTest(
      awaitGateBeforeSettlement(
        queued.promise,
        followupDispatched.promise,
        "Explicit followup did not queue",
      ),
      signal,
    );
    await withinTest(followupDispatched.promise, signal);
    expect(isRpcSourceQueued(rpcSourceTesting.get(followupId))).toBe(true);
    expect(operation.result).toBeNull();
    expect(injected).not.toHaveBeenCalled();
    expect(consumed).toEqual([]);
    await withinTest(followupOutcome.promise, signal);
    expect(fixture.context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: followupId,
        state: "delta",
        message: expect.objectContaining({
          content: [
            {
              type: "text",
              text: "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.",
            },
          ],
        }),
      }),
      expect.anything(),
    );
    // Dequeue reads current policy while retaining the new source's human identity.
    config.tools = { ...config.tools, deny: ["exec"] };
    setRuntimeConfigSnapshot(config, config);
    operation.complete();
    await withinTest(
      awaitGateBeforeSettlement(
        started.promise,
        settled.promise,
        "Explicit followup settled without execution",
      ),
      signal,
    );
    expect(consumed).toHaveLength(1);
    const run = consumed[0]!.followupRun;
    expect(run.prompt).toContain("Answer Bob's separate request.");
    expect(run.prompt).not.toContain("/followup");
    expect(run.operatorAuthority?.profileId).toBe(bob.id);
    expect(run.run.requesterOrigin?.operatorProfileId).toBe(bob.id);
    expect(run.run.config.tools?.deny).toEqual(["exec"]);
    expect(consumed[0]!.replyOperation?.requesterPrincipalKey).toBe(
      resolveRequesterPrincipalKey({ operatorProfileId: bob.id }),
    );
    release.resolve();
    await withinTest(settled.promise, signal);
    await fixture.finishDispatch();
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual(pending.items);
    fixture.params.idempotencyKey = "strict-steer-bob-input";
    fixture.params.message = "Raw follow-up awaiting approval.";
    fixture.context.dedupe.clear();
    rotateAgentEventLifecycleGeneration();
    const afterRestart = await fixture.send();
    expect(afterRestart.mock.calls[0]?.[0]).toBe(false);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual(pending.items);
  } finally {
    release.resolve();
    clearSessionQueues(
      [fixture.scope.sessionKey],
      captureSessionTarget({
        storeScope: fixture.scope.storePath,
        sessionKey: fixture.scope.sessionKey,
        incarnation: fixture.scope.sessionId,
        agentId: fixture.scope.agentId,
      }),
    );
    await fixture.cleanup();
  }
});

it.for([false, true])(
  "preserves chat.send behind a direct announce (tool_authority_mismatch, cancel=%s)",
  async (cancel, { signal }) => {
    const reason = "tool_authority_mismatch";
    const wait = <T>(pending: PromiseLike<T>) => withinTest(pending, signal);
    const waitForGate = (...args: Parameters<typeof awaitGateBeforeSettlement>) =>
      wait(awaitGateBeforeSettlement(...args));
    const actualRuns = await vi.importActual<typeof runs>(
      "../../agents/embedded-agent-runner/runs.js",
    );
    const embeddedRuntime = await replyRunHelpers.loadEmbeddedAgentRuntime();
    const runtimeLoader = vi
      .spyOn(replyRunHelpers, "loadEmbeddedAgentRuntime")
      .mockResolvedValue({ ...embeddedRuntime, ...actualRuns });
    const fixture = await createFixture({ preserveContent: true });
    const { scope, context, params: sendParams, client } = fixture;
    const pendingStates = async () =>
      (await listSessionPendingInputs(scope)).items.map((input) => input.state);
    fixture.activeRun?.complete();
    sendParams.queueMode = "steer";
    sendParams.idempotencyKey = `direct-followup-${reason}-${cancel}`;
    runtime.execute.mockReset();

    const config = withFullRuntimeReplyConfig(context.getRuntimeConfig());
    config.messages = {
      ...config.messages,
      queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } },
    };
    context.getRuntimeConfig = () => config;
    const instance = createOperationalRunInstanceRef("announce:v1:synthetic-child");
    const authority = runAuthority.claimAgentRunDelegatedAuthority(instance);
    const requesterOrigin = captureRequesterOrigin({
      sessionKey: fixture.scope.sessionKey,
      operatorProfileId: fixture.client.authenticatedUserProfile?.profileId,
    })!;
    const injected = vi.fn(async () => {});
    const handle = {
      ...createEmbeddedRunHandle({
        runId: instance.runId,
        toolAuthorityFingerprint: "announce-tools",
        supportsTranscriptCommitWait: true,
      }),
      messageInjectionV2: { version: 2 as const, isAvailable: () => true, queueMessage: injected },
    };
    const queued = createDeferred();
    const dispatched = createDeferred();
    const settled = createDeferred();
    const mediaCaptured = createDeferred();
    const releaseMedia = createDeferred();
    const stopped = createDeferred();
    let dispatchReturned = false;
    let mediaHeld = false;
    const captureMedia = chatReplyMedia.captureWebchatReplyMediaScope;
    const mediaCapture = cancel
      ? vi
          .spyOn(chatReplyMedia, "captureWebchatReplyMediaScope")
          .mockImplementation(async (params) => {
            const media = await captureMedia(params);
            if (dispatchReturned && !mediaHeld && params.sessionKey === scope.sessionKey) {
              mediaHeld = true;
              mediaCaptured.resolve();
              await releaseMedia.promise;
            }
            return media;
          })
      : undefined;
    const clearRun = context.chatRunState.clearRun;
    const clearStoppedRun = cancel
      ? vi.spyOn(context.chatRunState, "clearRun").mockImplementation((runId) => {
          clearRun(runId);
          if (runId === sendParams.idempotencyKey) {
            stopped.resolve();
          }
        })
      : undefined;
    let stop: Promise<void> | undefined;
    let broadcastsAtStop = 0;
    const consumed: string[] = [];
    let recorder: UserTurnTranscriptRecorder | undefined;
    const directReady = createDeferred();
    const releaseDirect = createDeferred();
    const cleanupReady = createDeferred();
    const releaseCleanup = createDeferred();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const dispatchActual = await loadRealChatDispatch();
    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as Parameters<typeof dispatchInboundMessage>[0];
      recorder = params.replyOptions?.userTurnTranscriptRecorder;
      const lifecycle = expectDefined(params.replyOptions?.turnAdoptionLifecycle, "input custody");
      const onDeferred = expectDefined(lifecycle.onDeferred, "queue admission");
      lifecycle.onDeferred = () => {
        const result = onDeferred();
        queued.resolve();
        return result;
      };
      const onSettled = lifecycle.onSettled;
      lifecycle.onSettled = async () => {
        await onSettled?.();
        settled.resolve();
      };
      try {
        return await dispatchActual({ ...params, cfg: config });
      } finally {
        dispatchReturned = true;
        dispatched.resolve();
      }
    });
    runtime.execute.mockImplementation(async ({ followupRun, opts }) => {
      const runId = expectDefined(opts?.runId, "followup run ID");
      opts?.onAgentRunStart?.(runId);
      const input = expectDefined(followupRun.userTurnTranscriptRecorder, "input recorder");
      await input.persistApproved();
      consumed.push(followupRun.prompt);
      return successfulChatTurn(runId, "Followup answered.");
    });
    let command: Promise<void> | undefined;
    try {
      command = withSessionTurn(scope, async (operation, abortSignal) =>
        runWithAgentCommandRecoveryOwner({
          lifecycleGeneration,
          mode: "claim",
          opts: { message: "Synthetic subagent completion", runId: instance.runId, abortSignal },
          prepare: async () => ({ ...scope, sessionAgentId: "main", isNewSession: false }),
          run: async () => {
            // The command producer records this fence before starting a direct embedded run.
            await sessions.patchSessionEntryCore(scope, () => ({
              status: undefined,
              abortedLastRun: false,
              restartRecoveryRuns: [{ runId: instance.runId, lifecycleGeneration }],
            }));
            await withGatewayToolCallerIdentity(
              {
                agentId: scope.agentId,
                sessionKey: scope.sessionKey,
                operationalRunInstance: instance,
                embeddedRunToolAuthorityBinding: () => ({
                  source: "attempt",
                  requesterPrincipalKey: resolveRequesterPrincipalKey(requesterOrigin),
                  acceptsRequesterOrigin: (incoming) =>
                    hasSameRequesterOrigin(requesterOrigin, incoming),
                  assertRegistrationActive: () => {},
                  assertActive: () => {},
                  project: () => "human-tools",
                  projectAsync: async () => "human-tools",
                }),
              },
              () =>
                runs.attachActiveEmbeddedRun(
                  scope.sessionId,
                  handle,
                  scope.sessionKey,
                  undefined,
                  scope.agentId,
                  expectDefined(operation, "direct turn owner"),
                ),
            );
            directReady.resolve();
            await withinTest(releaseDirect.promise, signal);
            runs.detachActiveEmbeddedRun(scope.sessionId, handle);
            cleanupReady.resolve();
            await withinTest(releaseCleanup.promise, signal);
            await sessions.patchSessionEntryCore(scope, () => ({
              restartRecoveryRuns: undefined,
              status: "done",
            }));
          },
        }),
      );
      void command.catch(() => {});
      await withinTest(directReady.promise, signal);
      const directOwner = expectDefined(
        getSessionControllerOperation(scope.sessionKey),
        "direct command controller owner",
      );
      expect(sessions.loadSessionEntry(scope)).toMatchObject({
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: instance.runId, lifecycleGeneration }],
      });
      const ack = await fixture.send();
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      await waitForGate(
        queued.promise,
        dispatched.promise,
        "Dispatch returned without queue custody",
      );
      expect(isRpcSourceQueued(rpcSourceTesting.get(sendParams.idempotencyKey))).toBe(true);
      await withinTest(dispatched.promise, signal);
      expect(getSessionControllerOperation(scope.sessionKey)).toBe(directOwner);
      expect(consumed).toEqual([]);
      expect(injected).not.toHaveBeenCalled();
      if (cancel) {
        await wait(mediaCaptured.promise);
        const abortParams = { sessionKey: scope.sessionKey, runId: sendParams.idempotencyKey };
        const respond = vi.fn<RespondFn>();
        stop = handleChatAbortRequest({
          params: abortParams,
          req: { type: "req", id: "stop-queued-input", method: "chat.abort", params: abortParams },
          client,
          context,
          respond,
          isWebchatConnect: () => true,
        });
        void stop.catch(() => {});
        await waitForGate(stopped.promise, stop, "Stop completed without clearing its chat buffer");
        broadcastsAtStop = vi.mocked(context.broadcast).mock.calls.length;
        releaseMedia.resolve();
        await wait(stop);
        expect(respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [abortParams.runId],
        });
        await wait(settled.promise);
        await expectDefined(recorder, "queued input recorder").waitForPendingInputSettlement?.();
        expect(await pendingStates()).toEqual(["cancelled"]);
      }
      releaseDirect.resolve();
      await withinTest(cleanupReady.promise, signal);
      expect(getSessionControllerOperation(scope.sessionKey)).toBe(directOwner);
      expect((await listSessionPendingInputs(scope)).items.map((input) => input.state)).toEqual([
        cancel ? "cancelled" : "queued",
      ]);
      expect(consumed).toEqual([]);
      releaseCleanup.resolve();
      await command;
      if (cancel) {
        expect(consumed).toEqual([]);
        await fixture.finishDispatch();
        expect(
          vi
            .mocked(context.broadcast)
            .mock.calls.slice(broadcastsAtStop)
            .filter(
              ([event, payload]) =>
                event === "chat" &&
                isRecord(payload) &&
                payload.runId === sendParams.idempotencyKey &&
                payload.state === "delta",
            ),
        ).toEqual([]);
        expect(
          context.chatRunState.runs.get(sendParams.idempotencyKey)?.releaseBufferAuthority,
        ).toBeUndefined();
        return;
      }
      await wait(settled.promise);
      expect(consumed).toEqual([expect.stringContaining(sendParams.message)]);
      expect((await listSessionPendingInputs(scope)).total).toBe(0);
    } finally {
      releaseMedia.resolve();
      releaseDirect.resolve();
      releaseCleanup.resolve();
      try {
        runs.detachActiveEmbeddedRun(scope.sessionId, handle);
        runAuthority.releaseAgentRunDelegatedAuthority(authority);
        await command?.catch(() => {});
        clearSessionQueues(
          [scope.sessionKey],
          captureSessionTarget({
            storeScope: scope.storePath,
            sessionKey: scope.sessionKey,
            incarnation: scope.sessionId,
            agentId: scope.agentId,
          }),
        );
        await stop?.catch(() => {});
        await fixture.cleanup();
      } finally {
        mediaCapture?.mockRestore();
        clearStoppedRun?.mockRestore();
        runtimeLoader.mockRestore();
      }
    }
  },
);

it("preserves direct pre-adoption rejection guidance instead of publishing queued cancellation", async ({
  signal,
}) => {
  const fixture = await createFixture({ active: false, preserveContent: true });
  const runId = "direct-admission-rejected-before-adoption";
  fixture.params.idempotencyKey = runId;
  const config = withFullRuntimeReplyConfig(fixture.context.getRuntimeConfig());
  fixture.context.getRuntimeConfig = () => config;
  const dispatchActual = await loadRealChatDispatch();
  const dispatched = createDeferred();
  const originalCreate = restartRecovery.createReplyAgentRestartRecoveryController;
  const admissionFailure = createRestartRecoveryClaimChangedError();
  let inputSignal: AbortSignal | undefined;
  const rejectAdmission = vi
    .spyOn(restartRecovery, "createReplyAgentRestartRecoveryController")
    .mockImplementation((context) => {
      const recovery = originalCreate(context);
      if (context.opts?.runId !== runId) {
        return recovery;
      }
      return {
        ...recovery,
        admitUserTurn: async () => {
          throw admissionFailure;
        },
      };
    });
  runtime.execute.mockReset();
  dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
    const params = raw as Parameters<typeof dispatchInboundMessage>[0];
    inputSignal = params.replyOptions?.turnAdoptionLifecycle?.abortSignal;
    try {
      return await dispatchActual({ ...params, cfg: config });
    } finally {
      dispatched.resolve();
    }
  });
  const guidance =
    "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.";
  try {
    const ack = await fixture.send();
    expect(ack.mock.calls[0]?.[1]).toMatchObject({ runId, status: "started" });
    await withinTest(dispatched.promise, signal);
    await fixture.finishDispatch();
    expect(rejectAdmission).toHaveBeenCalledOnce();
    expect(inputSignal?.aborted).toBe(false);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(fixture.context.dedupe.get(`chat:${runId}`)).toMatchObject({
      ok: false,
      payload: { runId, status: "error", summary: guidance },
    });
    expect(fixture.context.broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId, state: "aborted" }),
      expect.anything(),
    );
    const replay = await fixture.send();
    expect(replay.mock.calls[0]?.[0]).toBe(false);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ runId, status: "error", summary: guidance });
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  } finally {
    rejectAdmission.mockRestore();
    await fixture.cleanup();
  }
});
