import { expect, it } from "vitest";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { createDeliverySuite } from "./agent-runner-delivery-suite.test-support.js";
import { createReplyAgentRestartRecoveryController } from "./agent-runner-restart-recovery.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

const { createFixture } = createDeliverySuite();

it.each(["claimless", "recovered"] as const)(
  "keeps a %s turn steerable after an unrelated terminal tombstone",
  async (admission) => {
    const fixture = await createFixture();
    const { storePath, replyOperation: operation, followupRun } = fixture.context;
    const sessionKey = fixture.context.sessionKey!;
    const { sessionId } = fixture;
    const admissionRunId = "gateway-current-run";
    const sourceTurnId = admission === "recovered" ? "gateway-original-source" : admissionRunId;
    let entry: SessionEntry = {
      sessionId,
      updatedAt: 1,
      restartRecoveryTerminalRunIds: ["gateway-previous-run"],
    };
    if (admission === "recovered") {
      entry.restartRecoveryDeliveryRunId = admissionRunId;
      entry.restartRecoveryDeliverySourceRunId = sourceTurnId;
    }
    await fixture.replace(entry);
    await using actor = createReplyRecoveryActorFixture({
      agentId: "main",
      storePath,
      sessionKey,
      getSessionId: () => operation.sessionId,
      operation,
    });
    await actor.bind();
    operation.attachBackend({
      kind: "embedded",
      runId: "backend-run",
      cancel: () => {},
      messageInjection: { isAvailable: () => true, queueMessage: async () => {} },
    });
    const controller = createReplyAgentRestartRecoveryController({
      activeSessionStore: undefined,
      cfg: {},
      followupRun,
      getActiveSessionEntry: () => entry,
      opts: undefined,
      replyOperation: operation,
      restartRecoverySourceTurnId: undefined,
      runtimePolicySessionKey: undefined,
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "webchat",
        MessageSid: admissionRunId,
      },
      sessionKey,
      setActiveSessionEntry: (next) => {
        entry = next;
      },
      storePath,
    });

    try {
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");

      const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
      expect(target).toMatchObject({ sourceTurnId });
      expect(
        resolveRestartRecoverySteeringBlockReason(entry, sessionId, target?.sourceTurnId ?? ""),
      ).toBeUndefined();
      expect(entry.restartRecoveryTerminalRunIds).toEqual(["gateway-previous-run"]);
    } finally {
      await controller.clear();
    }
  },
);
