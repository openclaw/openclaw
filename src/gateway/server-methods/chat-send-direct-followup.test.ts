import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { COMMAND_ADMISSION_OWNER } from "../../agents/agent-command-admission-owner.js";
import { runWithAgentCommandRecoveryOwner } from "../../agents/agent-command-recovery-owner.js";
import * as runs from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import * as replyRunHelpers from "../../auto-reply/reply/get-reply-run-helpers.js";
import { clearFollowupQueueForTest } from "../../auto-reply/reply/queue.test-helpers.js";
import * as sessions from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionPendingInputs } from "../../config/sessions/session-pending-input-history.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as runAuthority from "../../infra/agent-run-registry.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { loadRealChatDispatch, successfulChatTurn } from "./chat-send-authority.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));
vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

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
    const injected = vi.fn(async () => {});
    const handle = {
      ...createEmbeddedRunHandle({
        runId: instance.runId,
        toolAuthorityFingerprint: "announce-tools",
        supportsTranscriptCommitWait: true,
      }),
      messageInjectionV2: { version: 2 as const, isAvailable: () => true, queueMessage: injected },
    };
    const dispatched = createDeferred();
    const settled = createDeferred();
    const consumed: string[] = [];
    let recorder: UserTurnTranscriptRecorder | undefined;
    const directReady = createDeferred();
    const releaseDirect = createDeferred();
    const cleanupReady = createDeferred();
    const releaseCleanup = createDeferred();
    const commandBlocked = createDeferred();
    const readOwnerRelease = sessionAdmission.getSessionWorkAdmissionOwnerRelease;
    const ownerObserver = vi
      .spyOn(sessionAdmission, "getSessionWorkAdmissionOwnerRelease")
      .mockImplementation((params) => {
        const pending = readOwnerRelease(params);
        if (params.owner === COMMAND_ADMISSION_OWNER && pending) {
          commandBlocked.resolve();
        }
        return pending;
      });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const dispatchActual = await loadRealChatDispatch();
    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as Parameters<typeof dispatchInboundMessage>[0];
      recorder = params.replyOptions?.userTurnTranscriptRecorder;
      const lifecycle = expectDefined(params.replyOptions?.turnAdoptionLifecycle, "input custody");
      const onSettled = lifecycle.onSettled;
      lifecycle.onSettled = () => {
        onSettled?.();
        settled.resolve();
      };
      try {
        return await dispatchActual({ ...params, cfg: config });
      } finally {
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
      command = runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: { message: "Synthetic subagent completion", runId: instance.runId },
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
                assertActive: () => {},
                project: () => "human-tools",
                projectAsync: async () => "human-tools",
              }),
            },
            () => runs.setActiveEmbeddedRun(scope.sessionId, handle, scope.sessionKey),
          );
          directReady.resolve();
          await wait(releaseDirect.promise);
          runs.clearActiveEmbeddedRun(scope.sessionId, handle);
          cleanupReady.resolve();
          await wait(releaseCleanup.promise);
          await sessions.patchSessionEntryCore(scope, () => ({
            restartRecoveryRuns: undefined,
            status: "done",
          }));
        },
      });
      void command.catch(() => {});
      await wait(directReady.promise);
      const ack = await fixture.send();
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      await wait(dispatched.promise);
      expect(context.chatQueuedTurns.has(sendParams.idempotencyKey)).toBe(true);
      await waitForGate(
        commandBlocked.promise,
        settled.promise,
        "Queued input was abandoned while its direct predecessor still owned execution",
      );
      expect(consumed).toEqual([]);
      expect(injected).not.toHaveBeenCalled();
      if (cancel) {
        const abortParams = { sessionKey: scope.sessionKey, runId: sendParams.idempotencyKey };
        const respond = vi.fn<RespondFn>();
        await handleChatAbortRequest({
          params: abortParams,
          req: { type: "req", id: "stop-queued-input", method: "chat.abort", params: abortParams },
          client,
          context,
          respond,
          isWebchatConnect: () => true,
        });
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
      await wait(cleanupReady.promise);
      expect(await pendingStates()).toEqual([cancel ? "cancelled" : "queued"]);
      expect(consumed).toEqual([]);
      releaseCleanup.resolve();
      await command;
      if (cancel) {
        expect(consumed).toEqual([]);
        return;
      }
      await wait(settled.promise);
      expect(consumed).toEqual([expect.stringContaining(sendParams.message)]);
      expect((await listSessionPendingInputs(scope)).total).toBe(0);
    } finally {
      runs.clearActiveEmbeddedRun(scope.sessionId, handle);
      runAuthority.releaseAgentRunDelegatedAuthority(authority);
      releaseDirect.resolve();
      releaseCleanup.resolve();
      await command?.catch(() => {});
      clearFollowupQueueForTest(scope.sessionKey);
      await fixture.cleanup();
      runtimeLoader.mockRestore();
      ownerObserver.mockRestore();
    }
  },
);
