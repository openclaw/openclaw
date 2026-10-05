import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("restart recovery claim successors", () => {
  it("transfers an aborted Control UI claim to a queued successor", async () => {
    const scope = {
      storePath: path.join(tempDirs.make("openclaw-reply-claim-successor-"), "sessions.json"),
      sessionKey: "agent:main:main",
    };
    let entry: InternalSessionEntry = {
      abortedLastRun: true,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "interrupted-run",
      restartRecoveryDeliverySourceRunId: "interrupted-run",
      restartRecoverySourceIngress: "control-ui",
      sessionId: "session",
      status: "running",
      updatedAt: 1,
    };
    await replaceSessionEntry(scope, entry);
    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      admissionRunId: "queued-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => entry.sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      setEntry: (next) => {
        entry = next;
      },
      ...scope,
    });

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");

    expect(loadSessionEntry(scope)).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "queued-run",
      restartRecoveryDeliverySourceRunId: "queued-run",
      restartRecoverySourceIngress: "control-ui",
      restartRecoveryTerminalRunIds: ["interrupted-run"],
      status: "running",
    });
  });

  it("rejects a successor when its recovery transfer loses ownership", async () => {
    const scope = {
      storePath: path.join(
        tempDirs.make("openclaw-reply-claim-refused-successor-"),
        "sessions.json",
      ),
      sessionKey: "agent:main:main",
    };
    let entry: InternalSessionEntry = {
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "interrupted-run",
      restartRecoveryDeliverySourceRunId: "interrupted-run",
      restartRecoverySourceIngress: "control-ui",
      sessionId: "session",
      status: "running",
      updatedAt: 1,
    };
    await replaceSessionEntry(scope, entry);
    let didSetEntry = false;
    let replacement: ReturnType<typeof updateSessionEntry> | undefined;
    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      admissionRunId: "queued-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => entry.sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => {
        replacement ??= updateSessionEntry(scope, () => ({
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: "replacement-run",
          restartRecoveryDeliverySourceRunId: "replacement-run",
          updatedAt: 2,
        }));
        return undefined;
      },
      setEntry: (next) => {
        didSetEntry = true;
        entry = next;
      },
      ...scope,
    });
    const outcome = await controller.admitUserTurn().catch((error: unknown) => error);
    await replacement;

    expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
    expect(didSetEntry).toBe(false);
    expect(loadSessionEntry(scope)).toMatchObject({
      restartRecoveryDeliveryRunId: "replacement-run",
      restartRecoveryDeliverySourceRunId: "replacement-run",
    });
  });

  it("tracks a channel claim after retiring an aborted Control UI predecessor", async () => {
    const storePath = path.join(
      tempDirs.make("openclaw-reply-claim-channel-successor-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:telegram:group:chat";
    const sessionId = "session";
    const sourceTurnId = "channel-turn";
    const deliveryContext = { channel: "telegram", to: "chat", accountId: "default" };
    let entry: InternalSessionEntry = {
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "interrupted-control-ui-run",
      restartRecoveryDeliverySourceRunId: "interrupted-control-ui-run",
      restartRecoverySourceIngress: "control-ui",
      sessionId,
      status: "running",
      updatedAt: 1,
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const recorder = createUserTurnTranscriptRecorder({
      message: {
        role: "user",
        content: "continue from Telegram",
        idempotencyKey: sourceTurnId,
        timestamp: Date.now(),
      },
      target: {
        agentId: "main",
        sessionEntry: entry,
        sessionId,
        sessionKey,
        storePath,
      },
      updateMode: "none",
    });
    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      admissionRunId: sourceTurnId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => deliveryContext,
      setEntry: (next) => {
        entry = next;
      },
      sourceTurnId,
      storePath,
      sessionKey,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    const admittedRunId = loadSessionEntry({ storePath, sessionKey })?.restartRecoveryDeliveryRunId;
    expect(admittedRunId).toEqual(expect.any(String));
    await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
    await controller.checkpointBeforeAgentReply({
      state: "handled-reply",
      pendingFinalDelivery: {
        intentId: "channel-intent",
        text: "channel reply",
        deliveries: [{ id: "channel-delivery", state: "prepared" }],
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      pendingFinalDelivery: { intentId: "channel-intent", text: "channel reply" },
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryDeliveryRunId: admittedRunId,
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoverySourceIngress: "channel",
    });

    entry = (await updateSessionEntry({ storePath, sessionKey }, () => ({
      abortedLastRun: true,
    }))) as InternalSessionEntry;
    await expect(controller.isArmed()).resolves.toBe(true);
    await controller.clear();

    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      pendingFinalDelivery: { intentId: "channel-intent", text: "channel reply" },
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryTerminalRunIds: ["interrupted-control-ui-run", sourceTurnId],
    });
    expect(
      loadSessionEntry({ storePath, sessionKey })?.restartRecoveryDeliveryRunId,
    ).toBeUndefined();
  });
});
