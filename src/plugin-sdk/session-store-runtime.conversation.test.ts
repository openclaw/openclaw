import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  deleteSessionEntry,
  getConversationSession,
  getSessionEntry,
  normalizeSessionDeliveryState,
  patchSessionEntry,
  upsertSessionEntry,
} from "./session-store-runtime.js";

describe("current conversation session binding", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-conversation-"));
    storePath = path.join(tempDir, "sessions.sqlite");
  });

  afterEach(async () => {
    // Retained reclamation cleanup still needs the shared-state broker.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
    // A Vitest thread cannot retire an escaped reclamation lease after this case.
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  });

  it("reads conversation changes inside their owning transaction and respects rollback", async () => {
    const databaseOptions = { agentId: "main", env: { OPENCLAW_STATE_DIR: tempDir } };
    const scope = { ...databaseOptions, sessionKey: "agent:main:reef:group:room" };
    const replacementScope = { ...scope, sessionKey: `${scope.sessionKey}:thread:first` };
    const address = {
      ...databaseOptions,
      channel: "reef",
      accountId: "default",
      kind: "group" as const,
      peerId: "room",
      threadId: "first",
    };
    const delivery = normalizeSessionDeliveryState({
      context: { channel: "reef", accountId: "default", to: "group:room", threadId: "first" },
    });
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "original", updatedAt: 100, chatType: "group", delivery },
    });
    const rollback = new Error("Roll back the conversation reassignment");
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        replaceSessionEntrySync(replacementScope, {
          sessionId: "replacement",
          updatedAt: 200,
          chatType: "group",
          delivery,
        });
        expect(getConversationSession(address)).toEqual({
          sessionKey: replacementScope.sessionKey,
          sessionId: "replacement",
        });
        throw rollback;
      }, databaseOptions),
    ).toThrow(rollback);
    expect(getConversationSession(address)).toEqual({
      sessionKey: scope.sessionKey,
      sessionId: "original",
    });
    expect(getSessionEntry(replacementScope)).toBeUndefined();
  });

  it("rejects a title patch when another session takes its conversation before commit", async () => {
    const scope = { agentId: "main", storePath, sessionKey: "agent:main:reef:group:room" };
    const replacementScope = { ...scope, sessionKey: `${scope.sessionKey}:thread:first` };
    const address = {
      agentId: "main",
      storePath,
      channel: "reef",
      accountId: "default",
      kind: "group" as const,
      peerId: "room",
      threadId: "first",
    };
    const delivery = normalizeSessionDeliveryState({
      context: { channel: "reef", accountId: "default", to: "group:room", threadId: "first" },
    });
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "original", updatedAt: 100, chatType: "group", delivery },
    });
    const original = getSessionEntry(scope);
    const replacement = {
      sessionId: "replacement",
      updatedAt: 200,
      chatType: "group" as const,
      delivery,
    };
    const rename = patchSessionEntry({
      ...scope,
      preserveActivity: true,
      assertCommitAllowed: () => {
        if (getConversationSession(address)?.sessionKey !== scope.sessionKey) {
          throw new Error("Conversation owner changed before title commit");
        }
      },
      update: () => {
        expect(getConversationSession(address)?.sessionKey).toBe(scope.sessionKey);
        // Another row can take the address while the SDK awaits this callback's result.
        queueMicrotask(() => replaceSessionEntrySync(replacementScope, replacement));
        return { displayName: "Late title for the original owner" };
      },
    });
    await expect(rename).rejects.toThrow("Conversation owner changed before title commit");
    expect(getSessionEntry(scope)).toEqual(original);
    expect(getConversationSession(address)).toEqual({
      sessionKey: replacementScope.sessionKey,
      sessionId: replacement.sessionId,
    });
    expect(getSessionEntry(replacementScope)).not.toHaveProperty("displayName");
  });

  it("does not let a later parent turn replace an existing thread owner", async () => {
    const parentKey = "agent:main:reef:group:room";
    const threadKey = `${parentKey}:thread:first`;
    const address = {
      agentId: "main",
      storePath,
      channel: "reef",
      accountId: "default",
      kind: "group" as const,
      peerId: "room",
      threadId: "first",
    };
    for (const [sessionKey, sessionId, threadId, updatedAt] of [
      [parentKey, "parent", "first", 100],
      [threadKey, "thread", "first", 200],
      [parentKey, "parent", "second", 300],
    ] as const) {
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
        entry: {
          sessionId,
          updatedAt,
          chatType: "group",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "reef", accountId: "default", to: "group:room", threadId },
          }),
        },
      });
    }
    expect(getConversationSession(address)).toEqual({ sessionKey: threadKey, sessionId: "thread" });
    await deleteSessionEntry({ agentId: "main", sessionKey: threadKey, storePath });
    expect(getConversationSession(address)).toBeUndefined();
  });
});
