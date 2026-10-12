import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  captureSessionEntryCurrentCheck,
  captureSessionEntryCurrentCheckAsync,
  composeSessionEntryCommitGuards,
} from "./session-binding-runtime.js";
import {
  deleteSessionEntry,
  getConversationSession,
  getConversationSessionAsync,
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

  it.each(["policy", "conversation"] as const)(
    "observes committed %s changes in async effect checks without host SQLite",
    async (change) => {
      const scope = { agentId: "main", storePath, sessionKey: "agent:main:reef:group:room" };
      const address = {
        ...scope,
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
        entry: {
          sessionId: "original",
          updatedAt: 100,
          permissionMode: "workspace",
          chatType: "group",
          delivery,
        },
      });
      const current = await captureSessionEntryCurrentCheckAsync({
        ...scope,
        fields: ["permissionMode"],
        alternatives: [{ conversations: [{ ...address, sessionKey: scope.sessionKey }] }],
      });
      const hostSql = observeHostDataSql();
      try {
        await expect(current.isCurrent()).resolves.toBe(true);
        await expect(current.assertCurrent()).resolves.toBeUndefined();
        current.source.assertScopeCurrent();
      } finally {
        hostSql.restore();
      }
      expect(hostSql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      await upsertSessionEntry({
        ...scope,
        sessionKey:
          change === "conversation" ? `${scope.sessionKey}:thread:first` : scope.sessionKey,
        entry: {
          sessionId: change === "conversation" ? "replacement" : "original",
          updatedAt: 200,
          permissionMode: "full",
          chatType: "group",
          delivery,
        },
      });
      const changedSql = observeHostDataSql();
      try {
        await expect(current.isCurrent()).resolves.toBe(false);
        await expect(current.assertCurrent()).rejects.toThrow("selected session changed");
      } finally {
        changedSql.restore();
      }
      expect(changedSql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    },
  );

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
    const hostSql = observeHostDataSql();
    try {
      expect(await getConversationSessionAsync(address)).toEqual({
        sessionKey: scope.sessionKey,
        sessionId: "original",
      });
      await upsertSessionEntry({
        ...replacementScope,
        entry: { sessionId: "replacement", updatedAt: 200, chatType: "group", delivery },
      });
      expect(await getConversationSessionAsync(address)).toEqual({
        sessionKey: replacementScope.sessionKey,
        sessionId: "replacement",
      });
    } finally {
      hostSql.restore();
    }
    expect(hostSql.queries.filter(isSessionEntryDataSql)).toEqual([]);
  });

  it("keeps prepared guards on the canonical row selected by shorthand and normalized keys", async () => {
    const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "original", updatedAt: 100 },
    });
    for (const sessionKey of [" main ", " AGENT:MAIN:main "]) {
      const current = await captureSessionEntryCurrentCheck({ ...scope, sessionKey });
      expect(current.isCurrent()).toBe(true);
      const hostSql = observeHostDataSql();
      try {
        await patchSessionEntry({
          ...scope,
          sessionKey,
          skipMaintenance: true,
          assertCommitAllowed: current.assertCurrent,
          update: () => ({ displayName: sessionKey }),
        });
      } finally {
        hostSql.restore();
      }
      expect(hostSql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      expect(getSessionEntry(scope)?.displayName).toBe(sessionKey);
    }
  });

  it("rejects a retargeted foreign conversation store even when its session key is unchanged", async () => {
    const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "title-owner", updatedAt: 100, displayName: "Original title" },
    });
    const firstDirectory = path.join(tempDir, "foreign-first");
    const secondDirectory = path.join(tempDir, "foreign-second");
    const aliasDirectory = path.join(tempDir, "foreign-alias");
    const conversationKey = "agent:main:reef:group:foreign-room";
    const address = {
      agentId: "main",
      storePath: path.join(aliasDirectory, "sessions.sqlite"),
      channel: "reef",
      accountId: "default",
      kind: "group" as const,
      peerId: "foreign-room",
      threadId: "first",
    };
    const delivery = normalizeSessionDeliveryState({
      context: {
        channel: "reef",
        accountId: "default",
        to: "group:foreign-room",
        threadId: "first",
      },
    });
    for (const [index, directory] of [firstDirectory, secondDirectory].entries()) {
      fs.mkdirSync(directory);
      await upsertSessionEntry({
        agentId: "main",
        storePath: path.join(directory, "sessions.sqlite"),
        sessionKey: conversationKey,
        entry: { sessionId: `foreign-${index}`, updatedAt: 100, chatType: "group", delivery },
      });
    }
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(firstDirectory, aliasDirectory, linkType);
    const current = await captureSessionEntryCurrentCheck({
      ...scope,
      alternatives: [{ conversations: [{ ...address, sessionKey: conversationKey }] }],
      errorMessage: "Conversation source changed before title commit",
    });
    expect(current.isCurrent()).toBe(true);
    await patchSessionEntry({
      ...scope,
      skipMaintenance: true,
      assertCommitAllowed: current.assertCurrent,
      update: () => ({ displayName: "Accepted title" }),
    });
    expect(getSessionEntry(scope)?.displayName).toBe("Accepted title");

    fs.unlinkSync(aliasDirectory);
    fs.symlinkSync(secondDirectory, aliasDirectory, linkType);
    expect(getConversationSession(address)).toEqual({
      sessionKey: conversationKey,
      sessionId: "foreign-1",
    });
    await expect(
      patchSessionEntry({
        ...scope,
        skipMaintenance: true,
        assertCommitAllowed: current.assertCurrent,
        update: () => ({ displayName: "Rejected title" }),
      }),
    ).rejects.toThrow("Conversation source changed before title commit");
    expect(getSessionEntry(scope)?.displayName).toBe("Accepted title");
  });

  it("preserves native transaction visibility for composed opaque SDK commit guards", async () => {
    const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "original", updatedAt: 100, displayName: "Original title" },
    });
    const observed: Array<{ inTransaction: boolean; displayName: string | undefined }> = [];
    const refusal = new Error("Opaque SDK guard refused the title change");
    await expect(
      patchSessionEntry({
        ...scope,
        skipMaintenance: true,
        assertCommitAllowed: composeSessionEntryCommitGuards([
          () => {
            observed.push({
              inTransaction:
                getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: storePath })?.db
                  .isTransaction === true,
              displayName: getSessionEntry(scope)?.displayName,
            });
            throw refusal;
          },
        ]),
        update: () => ({ displayName: "Rejected title" }),
      }),
    ).rejects.toThrow(refusal);
    expect(observed).toEqual([{ inTransaction: true, displayName: "Original title" }]);
    expect(getSessionEntry(scope)?.displayName).toBe("Original title");
  });

  it.each(["opaque", "prepared", "composed"] as const)(
    "rejects a %s title guard when another session takes its conversation before commit",
    async (guardKind) => {
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
      const current =
        guardKind !== "opaque"
          ? await captureSessionEntryCurrentCheck({
              ...scope,
              matchGeneration: false,
              alternatives: [{ conversations: [{ ...address, sessionKey: scope.sessionKey }] }],
              errorMessage: "Conversation owner changed before title commit",
            })
          : undefined;
      const assertCurrent =
        current &&
        (guardKind === "composed"
          ? composeSessionEntryCommitGuards([current.assertCurrent])
          : current.assertCurrent);
      if (current) {
        const hostSql = observeHostDataSql();
        try {
          await patchSessionEntry({
            ...scope,
            skipMaintenance: true,
            preserveActivity: true,
            assertCommitAllowed: assertCurrent,
            update: () => ({ displayName: "Current owner title" }),
          });
        } finally {
          hostSql.restore();
        }
        expect(
          hostSql.queries.filter(
            (sql) =>
              isSessionEntryDataSql(sql) || /\bconversations\b|\bconversation_sessions\b/.test(sql),
          ),
        ).toEqual([]);
      }
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
        assertCommitAllowed:
          assertCurrent ??
          (() => {
            if (getConversationSession(address)?.sessionKey !== scope.sessionKey) {
              throw new Error("Conversation owner changed before title commit");
            }
          }),
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
    },
  );

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
