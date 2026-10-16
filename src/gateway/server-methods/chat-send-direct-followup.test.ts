import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { COMMAND_ADMISSION_OWNER } from "../../agents/agent-command-admission-owner.js";
import { runWithAgentCommandRecoveryOwner } from "../../agents/agent-command-recovery-owner.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  captureRequesterOrigin,
  hasSameRequesterOrigin,
  resolveRequesterPrincipalKey,
} from "../../agents/requester-origin.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import * as replyRunHelpers from "../../auto-reply/reply/get-reply-run-helpers.js";
import { clearFollowupQueueForTest } from "../../auto-reply/reply/queue.test-helpers.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionPendingInputs } from "../../config/sessions/session-pending-input-history.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
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

it("refuses disabled cross-requester steering and admits only an explicit fresh followup", async ({
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
      allowCollaborativeSteering: false,
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
  const realDispatch = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
    "../../auto-reply/dispatch.js",
  );
  const realReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
    "../../auto-reply/reply/get-reply.js",
  );
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
      lifecycle.onSettled = () => {
        onSettled?.();
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
      return await realDispatch.dispatchInboundMessage({
        ...params,
        cfg: config,
        replyResolver: realReply.getReplyFromConfig,
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
    expect(injected).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
    expect(fixture.context.chatQueuedTurns.size).toBe(0);
    await withinTest(dispatched.promise, signal);
    await sessionAdmission.getSessionWorkAdmissionRelease({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
    });
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
      return {
        runId,
        outcome: {
          kind: "settled",
          status: "ok",
          result: {
            payloads: [{ text: "Bob's explicit followup answered." }],
            meta: { durationMs: 0 },
          },
          resolved: { provider: "openai", model: "gpt-test" },
          fallback: { exhausted: false, attempts: [] },
          autoCompactionCount: 0,
          didLogHeartbeatStrip: false,
        },
      };
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
    expect(fixture.context.chatQueuedTurns.has(followupId)).toBe(true);
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
    clearFollowupQueueForTest(fixture.scope.sessionKey);
    await fixture.cleanup();
  }
});

it.for([
  { reason: "tool_authority_mismatch", cancel: false },
  { reason: "tool_authority_mismatch", cancel: true },
] as const)(
  "preserves chat.send behind a direct announce ($reason, cancel=$cancel)",
  async ({ reason, cancel }, { signal }) => {
    const actualRuns = await vi.importActual<
      typeof import("../../agents/embedded-agent-runner/runs.js")
    >("../../agents/embedded-agent-runner/runs.js");
    const embeddedRuntime = await replyRunHelpers.loadEmbeddedAgentRuntime();
    const runtimeLoader = vi
      .spyOn(replyRunHelpers, "loadEmbeddedAgentRuntime")
      .mockResolvedValue({ ...embeddedRuntime, ...actualRuns });
    const fixture = await createFixture({ preserveContent: true });
    fixture.activeRun?.complete();
    fixture.params.queueMode = "steer";
    fixture.params.idempotencyKey = `direct-followup-${reason}-${cancel}`;
    runtime.execute.mockReset();

    const config = withFullRuntimeReplyConfig(fixture.context.getRuntimeConfig());
    config.messages = {
      ...config.messages,
      queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } },
    };
    fixture.context.getRuntimeConfig = () => config;
    const instance = createOperationalRunInstanceRef("announce:v1:synthetic-child");
    const authority = claimAgentRunDelegatedAuthority(instance);
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
    const rejected = vi.spyOn(diagnosticLogger, "info");
    const queued = createDeferred();
    const dispatched = createDeferred();
    const started = createDeferred();
    const release = createDeferred();
    const settled = createDeferred();
    const consumed: string[] = [];
    let recorder: UserTurnTranscriptRecorder | undefined;
    const directStarted = createDeferred();
    const releaseDirect = createDeferred();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const waitingForCommand = createDeferred();
    const readOwnerRelease = sessionAdmission.getSessionWorkAdmissionOwnerRelease;
    const ownerObserver = vi
      .spyOn(sessionAdmission, "getSessionWorkAdmissionOwnerRelease")
      .mockImplementation((params) => {
        const pending = readOwnerRelease(params);
        if (params.owner === COMMAND_ADMISSION_OWNER && pending) {
          waitingForCommand.resolve();
        }
        return pending;
      });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const realDispatch = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
      "../../auto-reply/dispatch.js",
    );
    const realReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
      "../../auto-reply/reply/get-reply.js",
    );
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
      lifecycle.onSettled = () => {
        onSettled?.();
        settled.resolve();
      };
      try {
        return await realDispatch.dispatchInboundMessage({
          ...params,
          cfg: config,
          replyResolver: realReply.getReplyFromConfig,
        });
      } finally {
        dispatched.resolve();
      }
    });
    runtime.execute.mockImplementation(async ({ followupRun, opts }) => {
      const runId = expectDefined(opts?.runId, "followup run ID");
      opts?.onAgentRunStart?.(runId);
      await expectDefined(
        followupRun.userTurnTranscriptRecorder,
        "input recorder",
      ).persistApproved();
      consumed.push(followupRun.prompt);
      started.resolve();
      await withinTest(release.promise, signal);
      return {
        runId,
        outcome: {
          kind: "settled",
          status: "ok",
          result: { payloads: [{ text: "Followup answered." }], meta: { durationMs: 0 } },
          resolved: { provider: "openai", model: "gpt-test" },
          fallback: { exhausted: false, attempts: [] },
          autoCompactionCount: 0,
          didLogHeartbeatStrip: false,
        },
      };
    });
    let command: Promise<void> | undefined;
    try {
      command = runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: { message: "Synthetic subagent completion", runId: instance.runId },
        prepare: async () => ({ ...fixture.scope, sessionAgentId: "main", isNewSession: false }),
        run: async () => {
          // The command producer records this fence before starting a direct embedded run.
          await patchSessionEntryCore(fixture.scope, () => ({
            status: undefined,
            abortedLastRun: false,
            restartRecoveryRuns: [{ runId: instance.runId, lifecycleGeneration }],
          }));
          await withGatewayToolCallerIdentity(
            {
              agentId: fixture.scope.agentId,
              sessionKey: fixture.scope.sessionKey,
              operationalRunInstance: instance,
              embeddedRunToolAuthorityBinding: () => ({
                source: "attempt",
                acceptsRequesterOrigin: (incoming) =>
                  hasSameRequesterOrigin(requesterOrigin, incoming),
                assertActive: () => {},
                project: () => "human-tools",
                projectAsync: async () => "human-tools",
              }),
            },
            () => setActiveEmbeddedRun(fixture.scope.sessionId, handle, fixture.scope.sessionKey),
          );
          directStarted.resolve();
          await withinTest(releaseDirect.promise, signal);
          clearActiveEmbeddedRun(fixture.scope.sessionId, handle);
          cleanupStarted.resolve();
          await withinTest(releaseCleanup.promise, signal);
          await patchSessionEntryCore(fixture.scope, () => ({
            restartRecoveryRuns: undefined,
            status: "done",
          }));
        },
      });
      void command.catch(() => {});
      await withinTest(directStarted.promise, signal);
      expect(replyRunRegistry.get(fixture.scope.sessionKey)).toBeUndefined();
      expect(loadSessionEntry(fixture.scope)).toMatchObject({
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: instance.runId, lifecycleGeneration }],
      });
      const ack = await fixture.send();
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      expect(rejected).toHaveBeenCalledWith(
        "direct steering rejected; keeping input for followup",
        expect.objectContaining({ reason, runId: instance.runId }),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          queued.promise,
          dispatched.promise,
          "Dispatch returned without queue custody",
        ),
        signal,
      );
      expect(fixture.context.chatQueuedTurns.has(fixture.params.idempotencyKey)).toBe(true);
      await withinTest(dispatched.promise, signal);
      await withinTest(
        awaitGateBeforeSettlement(
          waitingForCommand.promise,
          settled.promise,
          "Queued input was abandoned while its direct predecessor still owned execution",
        ),
        signal,
      );
      expect(consumed).toEqual([]);
      expect(injected).not.toHaveBeenCalled();
      if (cancel) {
        const params = {
          sessionKey: fixture.scope.sessionKey,
          runId: fixture.params.idempotencyKey,
        };
        const respond = vi.fn<RespondFn>();
        await handleChatAbortRequest({
          params,
          req: { type: "req", id: "stop-queued-input", method: "chat.abort", params },
          client: fixture.client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => true,
        });
        expect(respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [params.runId],
        });
        await withinTest(settled.promise, signal);
        await expectDefined(recorder, "queued input recorder").waitForPendingInputSettlement?.();
        expect(
          (await listSessionPendingInputs(fixture.scope)).items.map((input) => input.state),
        ).toEqual(["cancelled"]);
      }
      releaseDirect.resolve();
      await withinTest(cleanupStarted.promise, signal);
      expect(
        (await listSessionPendingInputs(fixture.scope)).items.map((input) => input.state),
      ).toEqual([cancel ? "cancelled" : "queued"]);
      expect(consumed).toEqual([]);
      releaseCleanup.resolve();
      await command;
      if (cancel) {
        expect(consumed).toEqual([]);
        return;
      }
      await withinTest(
        awaitGateBeforeSettlement(
          started.promise,
          settled.promise,
          "Followup settled without running",
        ),
        signal,
      );
      expect(consumed).toEqual([expect.stringContaining(fixture.params.message)]);
      release.resolve();
      await withinTest(settled.promise, signal);
      expect((await listSessionPendingInputs(fixture.scope)).total).toBe(0);
    } finally {
      clearActiveEmbeddedRun(fixture.scope.sessionId, handle);
      releaseAgentRunDelegatedAuthority(authority);
      release.resolve();
      releaseDirect.resolve();
      releaseCleanup.resolve();
      await command?.catch(() => {});
      clearFollowupQueueForTest(fixture.scope.sessionKey);
      await fixture.cleanup();
      rejected.mockRestore();
      runtimeLoader.mockRestore();
      ownerObserver.mockRestore();
    }
  },
);
