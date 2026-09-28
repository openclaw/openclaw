import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createReplyAgentRestartRecoveryController } from "./agent-runner-execute.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("admitted Gateway source identity", () => {
  it.each(["claimless", "recovered"] as const)(
    "keeps a %s turn steerable after an unrelated terminal tombstone",
    async (admission) => {
      const root = tempDirs.make("openclaw-source-identity-");
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:source-identity";
      const sessionId = "session-1";
      const admissionRunId = "gateway-current-run";
      const sourceTurnId = admission === "recovered" ? "gateway-original-source" : admissionRunId;
      let entry: SessionEntry = {
        sessionId,
        status: "running",
        updatedAt: 1,
        restartRecoveryTerminalRunIds: ["gateway-previous-run"],
        ...(admission === "recovered"
          ? {
              restartRecoveryDeliveryRunId: admissionRunId,
              restartRecoveryDeliverySourceRunId: sourceTurnId,
            }
          : {}),
      };
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      onTestFinished(() => operation.complete());
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "backend-run",
        cancel: () => {},
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => {},
        },
      });
      const controller = createReplyAgentRestartRecoveryController({
        activeSessionStore: undefined,
        cfg: {},
        followupRun: {
          prompt: "Continue the current task",
          enqueuedAt: 1,
          run: {
            agentId: "main",
            agentDir: root,
            sessionId,
            sessionKey,
            sessionFile: sessionKey,
            workspaceDir: root,
            config: {},
            provider: "openai",
            model: "gpt-5.5",
            timeoutMs: 1_000,
            blockReplyBreak: "message_end",
          },
        },
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

      await expect(controller.admitUserTurn()).resolves.toBe("admitted");

      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
      expect(target).toMatchObject({ sourceTurnId });
      expect(
        resolveRestartRecoverySteeringBlockReason(entry, sessionId, target?.sourceTurnId ?? ""),
      ).toBeUndefined();
      expect(entry.restartRecoveryTerminalRunIds).toEqual(["gateway-previous-run"]);
    },
  );
});
