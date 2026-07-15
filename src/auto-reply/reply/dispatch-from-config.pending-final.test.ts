import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../reply-payload.js";
import {
  capturePendingFinalDeliveryIdentity,
  clearPendingFinalDeliveryAfterSuccess,
  reconcilePendingFinalDeliveryAfterSettlement,
} from "./dispatch-from-config.pending-final.js";

describe("pending final delivery restart proof", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-final-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeHookPendingFinal(): Promise<void> {
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "session",
      updatedAt: Date.now(),
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "hook reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryIntentId: "intent-1",
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryForceSafeTools: true,
      restartRecoverySourceIngress: "channel",
    } satisfies SessionEntry);
  }

  it("clears hook provenance only after the exact pending intent succeeds", async () => {
    await writeHookPendingFinal();
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-1",
      sessionKey,
      storePath,
    });

    await clearPendingFinalDeliveryAfterSuccess({ identity, sessionKey, storePath });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.pendingFinalDeliveryText).toBeUndefined();
    expect(entry?.pendingFinalDeliveryIntentId).toBeUndefined();
    expect(entry?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
    expect(entry?.restartRecoverySourceIngress).toBeUndefined();
  });

  it("keeps hook provenance when transport fails before delivery", async () => {
    await writeHookPendingFinal();
    const identity = capturePendingFinalDeliveryIdentity({
      intentId: "intent-1",
      sessionKey,
      storePath,
    });
    const payload: ReplyPayload = { text: "hook reply" };

    await reconcilePendingFinalDeliveryAfterSettlement({
      deliveries: [{ outcome: "failed-before-deliver", payload }],
      identity,
      replies: [payload],
      sessionKey,
      storePath,
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "hook reply",
      pendingFinalDeliveryIntentId: "intent-1",
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryForceSafeTools: true,
      restartRecoverySourceIngress: "channel",
    });
  });
});
