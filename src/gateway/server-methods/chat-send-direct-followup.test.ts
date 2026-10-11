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
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import * as replyRunHelpers from "../../auto-reply/reply/get-reply-run-helpers.js";
import { clearFollowupQueueForTest } from "../../auto-reply/reply/queue.test-helpers.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionPendingInputs } from "../../config/sessions/session-pending-input-history.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));
vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

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
