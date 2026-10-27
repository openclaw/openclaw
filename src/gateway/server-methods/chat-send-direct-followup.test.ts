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
import { createEnteredGate } from "../../agents/entered-gate.test-support.js";
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

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type DispatchParams = Parameters<typeof dispatchInboundMessage>[0];
type Gate = ReturnType<typeof createDeferred<void>>;

function observeAdmission(params: DispatchParams, queued: Gate, settled: Gate) {
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
}

function steeringConfig({ context }: Fixture) {
  const config = withFullRuntimeReplyConfig(context.getRuntimeConfig());
  config.messages = {
    ...config.messages,
    queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } },
  };
  context.getRuntimeConfig = () => config;
  return config;
}

function clearFixtureQueues({ scope }: Fixture) {
  clearSessionQueues(
    [scope.sessionKey],
    captureSessionTarget({
      storeScope: scope.storePath,
      sessionKey: scope.sessionKey,
      incarnation: scope.sessionId,
      agentId: scope.agentId,
    }),
  );
}

function expectChat(fixture: Fixture, runId: string, state: string, content: unknown[]) {
  expect(fixture.context.broadcast).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({ runId, state, message: expect.objectContaining({ content }) }),
    expect.anything(),
  );
}

async function recordInput({ followupRun, opts }: Parameters<typeof executeAgentTurn>[0]) {
  const runId = expectDefined(opts?.runId, "followup run ID");
  opts?.onAgentRunStart?.(runId);
  await expectDefined(followupRun.userTurnTranscriptRecorder, "input recorder").persistApproved();
  return runId;
}

it("refuses cross-requester steering by default and admits only an explicit fresh followup", async ({
  signal,
}) => {
  const wait = <T>(pending: PromiseLike<T>) => withinTest(pending, signal);
  const waitForGate = (...args: Parameters<typeof awaitGateBeforeSettlement>) =>
    wait(awaitGateBeforeSettlement(...args));
  const refusal =
    "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.";
  const fixture = await createFixture({ preserveContent: true });
  const operation = expectDefined(fixture.activeRun, "incumbent reply operation");
  const alice = ensureProfileForEmail("strict-steer-alice@example.test");
  const bob = ensureProfileForEmail("strict-steer-bob@example.test");
  setClientProfile(fixture.client, bob);
  fixture.params.queueMode = "steer";
  fixture.params.idempotencyKey = "strict-steer-bob-input";
  const config = steeringConfig(fixture);
  setRuntimeConfigSnapshot(config, config);
  const fingerprint = "strict-steer-incumbent-tools";
  operation.bindToolAuthoritySnapshot({
    requesterPrincipalKey: resolveRequesterPrincipalKey({ operatorProfileId: alice.id }),
    fingerprint: () => fingerprint,
    project: () => fingerprint,
  });
  operation.bindToolAuthorityRoute({ provider: "openai", model: "gpt-test" });
  operation.setPhase("running");
  const injected = vi.fn(async () => {});
  operation.attachBackend({
    kind: "embedded",
    runId: "strict-steer-alice-run",
    toolAuthorityFingerprint: fingerprint,
    cancel() {},
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: injected },
  });
  const dispatchActual = await loadRealChatDispatch();
  const dispatched = createDeferred();
  const followupId = "strict-steer-bob-explicit-followup";
  const queued = createDeferred();
  const followupDispatched = createDeferred();
  const started = createDeferred();
  const release = createDeferred();
  const settled = createDeferred();
  const consumed: Parameters<typeof executeAgentTurn>[0][] = [];
  runtime.execute.mockReset();
  runtime.execute.mockRejectedValue(new Error("Refused input must not execute"));
  dispatchInboundMessageMock.mockImplementation((raw: unknown) => {
    const params = raw as DispatchParams;
    const isExplicitFollowup = params.replyOptions?.runId === followupId;
    if (isExplicitFollowup) {
      observeAdmission(params, queued, settled);
    }
    return dispatchActual({ ...params, cfg: config }).finally(() => {
      (isExplicitFollowup ? followupDispatched : dispatched).resolve();
    });
  });
  try {
    expect((await fixture.send()).mock.calls[0]?.[1]).toMatchObject({ status: "started" });
    await wait(dispatched.promise);
    await rpcSourceTesting.get(fixture.params.idempotencyKey)?.input.settlement.promise;
    expect(injected).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
    expect(isRpcSourceQueued(rpcSourceTesting.get(fixture.params.idempotencyKey))).toBe(false);
    expect(runtime.execute).not.toHaveBeenCalled();
    expectChat(fixture, fixture.params.idempotencyKey, "final", [
      { type: "text", text: refusal, openclawStatusNotice: true },
    ]);
    const pending = await listSessionPendingInputs(fixture.scope);
    expect(pending).toMatchObject({
      total: 1,
      items: [{ runId: fixture.params.idempotencyKey, state: "cancelled" }],
    });
    expect((await fixture.send()).mock.calls[0]).toMatchObject({
      0: false,
      1: { status: "error", summary: refusal },
    });
    fixture.context.dedupe.clear();
    expect((await fixture.send()).mock.calls[0]).toMatchObject({
      0: true,
      1: { status: "ok", runId: fixture.params.idempotencyKey },
      3: { cached: true },
    });
    expect(runtime.execute).not.toHaveBeenCalled();
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual(pending.items);

    runtime.execute.mockImplementation(async (params) => {
      const runId = await recordInput(params);
      consumed.push(params);
      started.resolve();
      await wait(release.promise);
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
    expect((await fixture.send()).mock.calls[0]?.[1]).toMatchObject({ status: "started" });
    await waitForGate(
      queued.promise,
      followupDispatched.promise,
      "Explicit followup did not queue",
    );
    await wait(followupDispatched.promise);
    expect(isRpcSourceQueued(rpcSourceTesting.get(followupId))).toBe(true);
    expect(operation.result).toBeNull();
    expect(injected).not.toHaveBeenCalled();
    expect(consumed).toEqual([]);
    await wait(followupOutcome.promise);
    expectChat(fixture, followupId, "delta", [
      {
        type: "text",
        text: "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.",
      },
    ]);
    // Dequeue reads current policy while retaining the new source's human identity.
    config.tools = { ...config.tools, deny: ["exec"] };
    setRuntimeConfigSnapshot(config, config);
    operation.complete();
    await waitForGate(
      started.promise,
      settled.promise,
      "Explicit followup settled without execution",
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
    await wait(settled.promise);
    await fixture.finishDispatch();
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual(pending.items);
    fixture.params.idempotencyKey = "strict-steer-bob-input";
    fixture.params.message = "Raw follow-up awaiting approval.";
    fixture.context.dedupe.clear();
    rotateAgentEventLifecycleGeneration();
    expect((await fixture.send()).mock.calls[0]).toMatchObject({
      0: true,
      1: { status: "ok", runId: fixture.params.idempotencyKey },
      3: { cached: true },
    });
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual(pending.items);
  } finally {
    release.resolve();
    clearFixtureQueues(fixture);
    await fixture.cleanup();
  }
});

it.for([false, true])(
  "preserves chat.send behind a direct announce (tool_authority_mismatch, cancel=%s)",
  async (cancel, { signal }) => {
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
    sendParams.idempotencyKey = `direct-followup-tool_authority_mismatch-${cancel}`;
    runtime.execute.mockReset();

    const config = steeringConfig(fixture);
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
    const mediaGate = createEnteredGate();
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
              await mediaGate.wait();
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
    const directGate = createEnteredGate();
    const cleanupGate = createEnteredGate();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const dispatchActual = await loadRealChatDispatch();
    dispatchInboundMessageMock.mockImplementation((raw: unknown) => {
      const params = raw as DispatchParams;
      recorder = params.replyOptions?.userTurnTranscriptRecorder;
      observeAdmission(params, queued, settled);
      return dispatchActual({ ...params, cfg: config }).finally(() => {
        dispatchReturned = true;
        dispatched.resolve();
      });
    });
    runtime.execute.mockImplementation(async (params) => {
      const runId = await recordInput(params);
      consumed.push(params.followupRun.prompt);
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
            await wait(directGate.wait());
            runs.detachActiveEmbeddedRun(scope.sessionId, handle);
            await wait(cleanupGate.wait());
            await sessions.patchSessionEntryCore(scope, () => ({
              restartRecoveryRuns: undefined,
              status: "done",
            }));
          },
        }),
      );
      void command.catch(() => {});
      await wait(directGate.entered);
      const directOwner = expectDefined(
        getSessionControllerOperation(scope.sessionKey),
        "direct command controller owner",
      );
      expect(sessions.loadSessionEntry(scope)).toMatchObject({
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: instance.runId, lifecycleGeneration }],
      });
      expect((await fixture.send()).mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      await waitForGate(
        queued.promise,
        dispatched.promise,
        "Dispatch returned without queue custody",
      );
      expect(isRpcSourceQueued(rpcSourceTesting.get(sendParams.idempotencyKey))).toBe(true);
      await wait(dispatched.promise);
      expect(getSessionControllerOperation(scope.sessionKey)).toBe(directOwner);
      expect(consumed).toEqual([]);
      expect(injected).not.toHaveBeenCalled();
      if (cancel) {
        await wait(mediaGate.entered);
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
        mediaGate.release();
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
      directGate.release();
      await wait(cleanupGate.entered);
      expect(getSessionControllerOperation(scope.sessionKey)).toBe(directOwner);
      expect(await pendingStates()).toEqual([cancel ? "cancelled" : "queued"]);
      expect(consumed).toEqual([]);
      cleanupGate.release();
      await command;
      if (cancel) {
        expect(consumed).toEqual([]);
        await fixture.finishDispatch();
        expect(vi.mocked(context.broadcast).mock.calls.slice(broadcastsAtStop)).not.toContainEqual(
          expect.objectContaining({
            0: "chat",
            1: expect.objectContaining({ runId: sendParams.idempotencyKey, state: "delta" }),
          }),
        );
        expect(
          context.chatRunState.runs.get(sendParams.idempotencyKey)?.releaseBufferAuthority,
        ).toBeUndefined();
        return;
      }
      await wait(settled.promise);
      expect(consumed).toEqual([expect.stringContaining(sendParams.message)]);
      expect((await listSessionPendingInputs(scope)).total).toBe(0);
    } finally {
      mediaGate.release();
      directGate.release();
      cleanupGate.release();
      try {
        runs.detachActiveEmbeddedRun(scope.sessionId, handle);
        runAuthority.releaseAgentRunDelegatedAuthority(authority);
        await command?.catch(() => {});
        clearFixtureQueues(fixture);
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
  dispatchInboundMessageMock.mockImplementation((raw: unknown) => {
    const params = raw as Parameters<typeof dispatchInboundMessage>[0];
    inputSignal = params.replyOptions?.turnAdoptionLifecycle?.abortSignal;
    return dispatchActual({ ...params, cfg: config }).finally(() => dispatched.resolve());
  });
  const guidance =
    "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.";
  try {
    expect((await fixture.send()).mock.calls[0]?.[1]).toMatchObject({ runId, status: "started" });
    await withinTest(dispatched.promise, signal);
    await fixture.finishDispatch();
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
    expect((await fixture.send()).mock.calls[0]).toMatchObject({
      0: false,
      1: { runId, status: "error", summary: guidance },
    });
  } finally {
    rejectAdmission.mockRestore();
    await fixture.cleanup();
  }
});
