import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { withAgentTurnCompletion } from "../auto-reply/reply/agent-runner-completion.js";
import { accountFollowupTurn } from "../auto-reply/reply/agent-runner-result-accounting.js";
import {
  deliverFollowupDecision,
  resolveFollowupDeliveryDecision,
} from "../auto-reply/reply/followup-delivery.js";
import {
  createSettledExecution,
  createTurn,
} from "../auto-reply/reply/followup-delivery.test-helpers.js";
import type { FollowupExecutionResult } from "../auto-reply/reply/followup-turn-execution.js";
import type { FollowupRunnerParams } from "../auto-reply/reply/reply-agent-turn-preparation.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.test-support.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { installQueueTestPlugin } from "../infra/outbound/deliver.custody.test-support.js";
import { deliverOutboundPayloadsInternal } from "../infra/outbound/deliver.js";
import { outboundDeliveryQueueName } from "../infra/outbound/delivery-queue-namespaces.js";
import { drainPendingDeliveriesCore } from "../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../infra/outbound/delivery-queue-storage.js";
import { createRecoveryLog } from "../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

// Fixed model output; real followup accounting, reset, and durable recovery own delivery.
it.each([false, true])(
  "recovers an unsent ordinary followup only without reset (reset=%s)",
  async (resetSession) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:reset-followup-durable";
    const sessionId = "before-reset-session";
    const lifecycleRevision = "before-reset-revision";
    const identity = { agentId: "main", sessionKey };
    const scope = { ...identity, storePath };
    await writeSessionStore({
      agentId: identity.agentId,
      storePath,
      entries: { [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }) },
    });
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    assert(stateDir, "Gateway test state directory is required");
    let offline = true;
    const visible: string[] = [];
    const outbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendText: async ({ text, onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        if (offline) {
          throw new PlatformMessageNotDispatchedError("transport did not dispatch", {
            cause: new Error("connection unavailable"),
          });
        }
        visible.push(text);
        return { channel: "matrix", messageId: `sent-${visible.length}` };
      },
    };
    installQueueTestPlugin({ outbound });
    const operation = createReplyOperation({
      ...identity,
      sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        agentId: "main",
        storeScope: storePath,
        sessionKey,
        incarnation: sessionId,
      }),
    });
    const typing = createTypingController({});
    try {
      const turn = createTurn({
        runId: "pre-reset-followup",
        operation,
        config: cfg,
        session: {
          kind: "session",
          key: sessionKey,
          storePath,
          current: () => loadSessionEntry(scope),
          publish() {},
        },
      });
      turn.queued.originatingChannel = "matrix";
      turn.queued.originatingTo = "!room:example";
      Object.assign(turn.queued.run, {
        ...identity,
        sessionId,
        config: cfg,
        messageProvider: "matrix",
        agentDir: path.join(dir, "agent"),
        workspaceDir: dir,
        sessionFile: path.join(dir, "session.jsonl"),
      });
      const defaults: FollowupRunnerParams = {
        defaultModel: "claude",
        typingMode: "never",
        typing,
      };
      const settled = createSettledExecution("pre-reset answer");
      settled.runId = turn.runId;
      operation.setPhase("running");
      settled.outcome.result.sourceReplyDeliveryState = "missing";
      settled.outcome.result.payloads = buildEmbeddedRunPayloads({
        assistantTexts: ["pre-reset answer"],
        lastAssistant: undefined,
        currentAssistant: null,
        assistantMessageIndex: 1,
        assistantTranscriptOwned: true,
        ...identity,
        runId: settled.runId,
        config: cfg,
        sourceReplyDeliveryState: "missing",
        sourceReplyDeliveryMode: "automatic",
      });
      const execution: FollowupExecutionResult = {
        execution: settled,
        commentaryPayloadsEnabled: false,
        runStartedAt: Date.now(),
        sessionCtx: {
          Provider: "matrix",
          Surface: "matrix",
          SessionKey: sessionKey,
          To: "!room:example",
        },
        pendingToolTasks: new Set(),
        progress: { drain: async () => {} },
      };
      const decision = await withAgentTurnCompletion(
        {
          ...scope,
          entry: turn.session.current(),
          operation,
          publish: (entry) => turn.session.publish(entry),
        },
        async (completion) => {
          const accounting = await accountFollowupTurn({ turn, defaults, execution, completion });
          const resolved = await resolveFollowupDeliveryDecision({
            turn,
            execution: settled,
            accounting,
          });
          await completion?.complete();
          return resolved;
        },
      );
      expect(decision.kind).toBe("deliver");
      const result = await deliverFollowupDecision({
        turn,
        decision,
        defaults,
        runId: settled.runId,
        runFollowup: async () => {
          throw new Error("Unexpected source retry");
        },
      });
      expect(result.kind).toBe("pending");
      expect(visible).toEqual([]);
      const pending = await loadUnfinishedDeliveries(stateDir);
      expect(pending).toHaveLength(1);
      const retained = pending[0];
      assert(retained, "Expected the unsent followup's durable owner");
      expect(retained.deliveryCompletion).toBeUndefined();

      // Mirrors followup-runner's finally after delivery transfers to the queue.
      operation.complete();

      if (resetSession) {
        const reset = await directSessionReq("sessions.reset", { key: sessionKey });
        expect(reset, JSON.stringify(reset)).toMatchObject({ ok: true });
        const afterReset = loadSessionEntry(scope);
        expect(afterReset).toBeDefined();
        expect(afterReset?.lifecycleRevision).not.toBe(lifecycleRevision);
      }
      offline = false;
      const log = createRecoveryLog();
      const recover = () =>
        drainPendingDeliveriesCore({
          cfg,
          stateDir,
          deliver: deliverOutboundPayloadsInternal,
          drainKey: "matrix:reset-followup-durable",
          logLabel: "Reset followup",
          log,
          selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
        });
      await recover();

      expect(visible).toEqual(resetSession ? [] : ["pre-reset answer"]);
      expect(retained.sessionGeneration).toEqual({ ...scope, sessionId, lifecycleRevision });
      if (resetSession) {
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining("original session generation no longer accepts"),
        );
      }
      // Ordinary followups have no terminal receipt; send or permanent rejection retires the row.
      expect(
        getDeliveryQueueEntryStatus(outboundDeliveryQueueName(retained), retained.id, stateDir),
      ).toBeUndefined();
      expect(await loadUnfinishedDeliveries(stateDir)).toHaveLength(0);
      await recover();
      expect(visible).toHaveLength(resetSession ? 0 : 1);
    } finally {
      operation.complete();
      typing.cleanup();
    }
  },
);
