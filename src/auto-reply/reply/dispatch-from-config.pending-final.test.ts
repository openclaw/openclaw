import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-claim.js";

describe("pending final delivery restart proof", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-final-");
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";

  beforeEach(() => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
  });

  async function writePendingFinal(
    beforeAgentReplyState: "handled-reply" | undefined,
    state: "prepared" | "delivered" = "delivered",
    updatedAt = Date.now(),
  ): Promise<void> {
    const entry: SessionEntry = {
      sessionId: "session",
      status: "running",
      startedAt: 10,
      lifecycleRunId: "active-run",
      updatedAt,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "hook reply",
        createdAt: 1,
        intentId: "intent-1",
        deliveries: [{ id: "delivery-1", state }],
      },
      restartRecoveryBeforeAgentReplyState: beforeAgentReplyState,
      restartRecoveryForceSafeTools: beforeAgentReplyState === "handled-reply" ? true : undefined,
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }

  function pendingFinalPayload(deliveryId = "delivery-1"): ReplyPayload {
    const payload: ReplyPayload = { text: "hook reply" };
    setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: {
        deliveryId,
        intentId: "intent-1",
        sessionId: "session",
        sessionKey,
        storePath,
      },
    });
    return payload;
  }

  it("clears hook provenance after its exact intent succeeds without changing user activity", async () => {
    await writePendingFinal("handled-reply", "delivered", 1);
    const identity = getReplyPayloadMetadata(pendingFinalPayload())?.pendingFinalDeliveryCompletion;

    await clearPendingFinalDeliveryAfterSuccess(identity, { preserveActivity: true });

    const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined;
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
    expect(entry?.restartRecoverySourceIngress).toBeUndefined();
    expect(entry?.status).toBe("done");
    expect(entry?.lifecycleRunId).toBeUndefined();
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.endedAt).toBeTypeOf("number");
    expect(entry?.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(entry?.updatedAt).toBe(1);
  });

  it("clears a skipped turn only after every sendable final is suppressed", async () => {
    await writePendingFinal(undefined, "prepared", 1);
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        ...(loadSessionEntry({ sessionKey, storePath }) as SessionEntry),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "hook reply",
          createdAt: 1,
          intentId: "intent-1",
          deliveries: [
            { id: "delivery-1", state: "prepared" },
            { id: "delivery-2", state: "prepared" },
          ],
        },
      },
    );

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-1"), {
      preserveActivity: true,
    });

    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry).pendingFinalDelivery
        ?.deliveries,
    ).toEqual([
      { id: "delivery-1", state: "suppressed" },
      { id: "delivery-2", state: "prepared" },
    ]);

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-2"), {
      preserveActivity: true,
    });

    const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry;
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.restartRecoverySourceIngress).toBeUndefined();
    expect(entry.status).toBe("running");
    expect(entry.lifecycleRunId).toBe("active-run");
    expect(entry.updatedAt).toBe(1);
  });

  it("does not retire a source while its terminal provider outcome is unknown", async () => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "done",
        updatedAt: Date.now(),
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "source-1",
      },
    );

    await expect(
      retireTerminalRestartRecoverySourceClaim({
        agentId: "main",
        sessionId: "session",
        sessionKey,
        sourceTurnId: "source-1",
        storePath,
      }),
    ).resolves.toBeUndefined();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
    });
    expect(
      loadSessionEntry({ sessionKey, storePath })?.restartRecoveryTerminalRunIds,
    ).toBeUndefined();
  });
});
