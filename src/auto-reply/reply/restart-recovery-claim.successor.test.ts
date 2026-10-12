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
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("restart recovery claim successors", () => {
  it.each([
    { outcome: "unsettled", status: undefined, transfers: true, losesOwnership: false },
    { outcome: "interrupted", status: "interrupted", transfers: true, losesOwnership: false },
    { outcome: "killed", status: "killed", transfers: false, losesOwnership: false },
    { outcome: "failed", status: "failed", transfers: false, losesOwnership: false },
    { outcome: "interrupted", status: "interrupted", transfers: false, losesOwnership: true },
  ] as const)(
    "handles an aborted $outcome Control UI claim (ownership lost: $losesOwnership)",
    async ({ status, transfers, losesOwnership }) => {
      const scope = {
        storePath: path.join(tempDirs.make("openclaw-reply-claim-successor-"), "sessions.json"),
        sessionKey: "agent:main:main",
      };
      let entry: InternalSessionEntry = {
        abortedLastRun: true,
        ...(!losesOwnership
          ? { restartRecoveryDeliveryRequestFingerprint: "request-fingerprint" }
          : {}),
        restartRecoveryDeliveryRunId: "interrupted-run",
        restartRecoveryDeliverySourceRunId: "interrupted-run",
        restartRecoverySourceIngress: "control-ui",
        sessionId: "session",
        status,
        updatedAt: 1,
      };
      await replaceSessionEntry(scope, entry);
      const before = loadSessionEntry(scope);
      let didSetEntry = false;
      let replacement: ReturnType<typeof updateSessionEntry> | undefined;
      await using actor = createReplyRecoveryActorFixture({
        agentId: "main",
        ...scope,
        getSessionId: () => entry.sessionId,
      });
      const controller = createReplyRestartRecoveryClaimController({
        agentId: "main",
        acquireSessionActor: () => actor.acquireSessionActor(),
        admissionRunId: "queued-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getEntry: () => entry,
        getSessionId: () => entry.sessionId,
        isRestartAbort: () => false,
        resolveDeliveryContext: () => {
          if (losesOwnership) {
            replacement ??= updateSessionEntry(scope, () => ({
              abortedLastRun: false,
              restartRecoveryDeliveryRunId: "replacement-run",
              restartRecoveryDeliverySourceRunId: "replacement-run",
              updatedAt: 2,
            }));
          }
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
      if (losesOwnership) {
        expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
        expect(didSetEntry).toBe(false);
        expect(loadSessionEntry(scope)).toMatchObject({
          restartRecoveryDeliveryRunId: "replacement-run",
          restartRecoveryDeliverySourceRunId: "replacement-run",
        });
      } else if (!transfers) {
        expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
        expect(loadSessionEntry(scope)).toEqual(before);
      } else {
        expect(outcome).toBe("admitted");
        expect(loadSessionEntry(scope)).toMatchObject({
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: "queued-run",
          restartRecoveryDeliverySourceRunId: "queued-run",
          restartRecoverySourceIngress: "control-ui",
          restartRecoveryTerminalRunIds: ["interrupted-run"],
        });
        expect(loadSessionEntry(scope)?.status).toBeUndefined();
      }
    },
  );

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
      status: "interrupted",
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
    await using actor = createReplyRecoveryActorFixture({
      agentId: "main",
      storePath,
      sessionKey,
      getSessionId: () => sessionId,
    });
    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      acquireSessionActor: () => actor.acquireSessionActor(),
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
    expect(loadSessionEntry({ storePath, sessionKey })?.status).toBeUndefined();
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
