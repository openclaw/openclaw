import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry as ConfigSessionEntry } from "./config-types.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  updateSessionStore,
  type SessionEntry,
} from "./session-store-runtime.js";

const sessionEntryKeepsCurrentRecoveryPrivate: "restartRecoveryDeliveryReceiptState" extends keyof SessionEntry
  ? false
  : true = true;
const configSessionEntryKeepsCurrentRecoveryPrivate: "restartRecoveryDeliveryReceiptState" extends keyof ConfigSessionEntry
  ? false
  : true = true;
void sessionEntryKeepsCurrentRecoveryPrivate;
void configSessionEntryKeepsCurrentRecoveryPrivate;

it("hides and preserves the shipped restart recovery coordination fields", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-current-recovery-"));
  const storePath = path.join(tempDir, "sessions.json");
  const sessionKey = "agent:main:recovery-coordination";
  const recoveryState = {
    restartRecoveryBeforeAgentReplyState: "continue" as const,
    restartRecoveryDeliveryReceiptState: "terminal-pending" as const,
    restartRecoveryDeliveryToolCallId: "message-call-1",
    restartRecoveryForceSafeTools: true as const,
    restartRecoveryRequesterAccountId: "account-1",
    restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    restartRecoverySourceIngress: "channel" as const,
  };

  try {
    await replaceInternalSessionEntry(
      { sessionKey, storePath },
      {
        ...recoveryState,
        model: "gpt-5.5",
        sessionId: "session-recovery-coordination",
        updatedAt: 10,
      },
    );

    const direct = getSessionEntry({ sessionKey, storePath });
    const listed = listSessionEntries({ storePath })[0]?.entry;
    for (const field of Object.keys(recoveryState)) {
      expect(direct).not.toHaveProperty(field);
      expect(listed).not.toHaveProperty(field);
    }

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: (entry) => {
        expect(entry).not.toHaveProperty("restartRecoveryDeliveryReceiptState");
        return {
          model: "gpt-5.6",
          restartRecoveryDeliveryReceiptState: "delivered-terminal",
          restartRecoveryRequesterAccountId: "plugin-account",
        } as unknown as Partial<SessionEntry>;
      },
    });

    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      ...recoveryState,
      model: "gpt-5.6",
    });

    await updateSessionStore(
      storePath,
      (store) => {
        expect(store[sessionKey]).not.toHaveProperty("restartRecoveryDeliveryReceiptState");
        Object.assign(store[sessionKey]!, {
          restartRecoveryDeliveryReceiptState: "delivered-terminal",
          restartRecoveryRequesterAccountId: "whole-store-plugin-account",
        });
      },
      { skipMaintenance: true },
    );
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject(recoveryState);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});
