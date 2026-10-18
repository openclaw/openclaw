import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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
  captureSessionEntryCurrentCheckAsync as captureCurrent,
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
  type SessionEntry,
} from "./session-store-runtime.js";

let tempDir: string;
let storePath: string;
type Scope = Parameters<typeof getSessionEntry>[0];
type Guard = Parameters<typeof patchSessionEntry>[0]["assertCommitAllowed"];
type Store = { agentId: string; storePath?: string; env?: NodeJS.ProcessEnv };
const store = () => ({ agentId: "main", storePath });
const binding = (scope: Scope, sessionId: string) => ({
  sessionKey: scope.sessionKey,
  sessionId,
});
const rename = (scope: Scope, title: string, guard: Guard, preserveActivity = false) =>
  patchSessionEntry({
    ...scope,
    skipMaintenance: true,
    preserveActivity,
    assertCommitAllowed: guard,
    update: () => ({ displayName: title }),
  });
const seedEntry = (scope: Scope, entry: Partial<SessionEntry> = {}) =>
  upsertSessionEntry({ ...scope, entry: { sessionId: "original", updatedAt: 100, ...entry } });

const transport = { channel: "reef", accountId: "default" };
const addressFor = (options: Store = store(), peerId = "room") => ({
  ...options,
  ...transport,
  kind: "group" as const,
  peerId,
  threadId: "first",
});
const deliveryFor = (peerId = "room", threadId = "first") =>
  normalizeSessionDeliveryState({
    context: { ...transport, to: `group:${peerId}`, threadId },
  });
async function seedConversation(options: Store = store(), entry: Partial<SessionEntry> = {}) {
  const scope = { ...options, sessionKey: "agent:main:reef:group:room" };
  const delivery = deliveryFor();
  await seedEntry(scope, { chatType: "group", delivery, ...entry });
  const replacementScope = { ...scope, sessionKey: `${scope.sessionKey}:thread:first` };
  const replacement = {
    sessionId: "replacement",
    updatedAt: 200,
    chatType: "group" as const,
    delivery,
  };
  return { scope, delivery, address: addressFor(options), replacementScope, replacement };
}
async function withoutEntrySql(run: () => Promise<void>, conversations = false) {
  const sql = observeHostDataSql();
  using _ = { [Symbol.dispose]: sql.restore };
  await run();
  expect(
    sql.queries.filter(
      (query) =>
        isSessionEntryDataSql(query) ||
        (conversations && /\bconversations\b|\bconversation_sessions\b/.test(query)),
    ),
  ).toEqual([]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-conversation-"));
  storePath = path.join(tempDir, "sessions.sqlite");
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  // Retained reclamation cleanup still needs the shared-state broker.
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  fs.rmSync(tempDir, { recursive: true, force: true });
  // A Vitest thread cannot retire an escaped reclamation lease after this case.
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
});

it.each(["policy", "conversation"] as const)(
  "observes committed %s changes in async effect checks without host SQLite",
  async (change) => {
    const { scope, address, delivery } = await seedConversation(undefined, {
      permissionMode: "workspace",
    });
    const current = await captureCurrent({
      ...scope,
      fields: ["permissionMode"],
      alternatives: [{ conversations: [{ ...address, sessionKey: scope.sessionKey }] }],
    });
    await withoutEntrySql(async () => {
      await expect(current.isCurrent()).resolves.toBe(true);
      await expect(current.assertCurrent()).resolves.toBeUndefined();
      current.source.assertScopeCurrent();
    });
    await upsertSessionEntry({
      ...scope,
      sessionKey: change === "conversation" ? `${scope.sessionKey}:thread:first` : scope.sessionKey,
      entry: {
        sessionId: change === "conversation" ? "replacement" : "original",
        updatedAt: 200,
        permissionMode: "full",
        chatType: "group",
        delivery,
      },
    });
    await withoutEntrySql(async () => {
      await expect(current.isCurrent()).resolves.toBe(false);
      await expect(current.assertCurrent()).rejects.toThrow("selected session changed");
    });
  },
);

it("reads conversation changes inside their owning transaction and respects rollback", async () => {
  const databaseOptions = { agentId: "main", env: { OPENCLAW_STATE_DIR: tempDir } };
  const { scope, replacementScope, address, replacement } = await seedConversation(databaseOptions);
  const rollback = new Error("Roll back the conversation reassignment");
  expect(() =>
    runOpenClawAgentWriteTransaction(() => {
      replaceSessionEntrySync(replacementScope, replacement);
      expect(getConversationSession(address)).toEqual(binding(replacementScope, "replacement"));
      throw rollback;
    }, databaseOptions),
  ).toThrow(rollback);
  expect(getConversationSession(address)).toEqual(binding(scope, "original"));
  expect(getSessionEntry(replacementScope)).toBeUndefined();
  await withoutEntrySql(async () => {
    expect(await getConversationSessionAsync(address)).toEqual(binding(scope, "original"));
    await upsertSessionEntry({ ...replacementScope, entry: replacement });
    expect(await getConversationSessionAsync(address)).toEqual(
      binding(replacementScope, "replacement"),
    );
  });
});

it("keeps prepared guards on the canonical row selected by shorthand and normalized keys", async () => {
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  await seedEntry(scope);
  for (const sessionKey of [" main ", " AGENT:MAIN:main "]) {
    const current = await captureCurrent({ ...scope, sessionKey });
    await expect(current.isCurrent()).resolves.toBe(true);
    await withoutEntrySql(async () => {
      await rename({ ...scope, sessionKey }, sessionKey, current.source);
    });
    expect(getSessionEntry(scope)?.displayName).toBe(sessionKey);
  }
});

it("rejects a retargeted foreign conversation store even when its session key is unchanged", async () => {
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  await seedEntry(scope, { sessionId: "title-owner", displayName: "Original title" });
  const firstDirectory = path.join(tempDir, "foreign-first");
  const secondDirectory = path.join(tempDir, "foreign-second");
  const aliasDirectory = path.join(tempDir, "foreign-alias");
  const conversationKey = "agent:main:reef:group:foreign-room";
  const address = addressFor(
    { agentId: "main", storePath: path.join(aliasDirectory, "sessions.sqlite") },
    "foreign-room",
  );
  const delivery = deliveryFor("foreign-room");
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
  const current = await captureCurrent({
    ...scope,
    alternatives: [{ conversations: [{ ...address, sessionKey: conversationKey }] }],
    errorMessage: "Conversation source changed before title commit",
  });
  await expect(current.isCurrent()).resolves.toBe(true);
  await rename(scope, "Accepted title", current.source);
  expect(getSessionEntry(scope)?.displayName).toBe("Accepted title");

  fs.unlinkSync(aliasDirectory);
  fs.symlinkSync(secondDirectory, aliasDirectory, linkType);
  expect(getConversationSession(address)).toEqual({
    sessionKey: conversationKey,
    sessionId: "foreign-1",
  });
  await expect(rename(scope, "Rejected title", current.source)).rejects.toThrow(
    "Conversation source changed before title commit",
  );
  expect(getSessionEntry(scope)?.displayName).toBe("Accepted title");
});

it("runs composed opaque SDK guards before committing the title change", async () => {
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  await seedEntry(scope, { displayName: "Original title" });
  const observed: Array<string | undefined> = [];
  const refusal = new Error("Opaque SDK guard refused the title change");
  const refuse = () => {
    observed.push(getSessionEntry(scope)?.displayName);
    throw refusal;
  };
  const guard = composeSessionEntryCommitGuards([refuse]);
  await expect(rename(scope, "Rejected title", guard)).rejects.toThrow(refusal);
  expect(observed).toEqual(["Original title"]);
  expect(getSessionEntry(scope)?.displayName).toBe("Original title");
});

it.each(["opaque", "prepared", "composed"] as const)(
  "rejects a %s title guard when another session takes its conversation before commit",
  async (guardKind) => {
    const { scope, replacementScope, address, replacement } = await seedConversation();
    const current =
      guardKind !== "opaque"
        ? await captureCurrent({
            ...scope,
            matchGeneration: false,
            alternatives: [{ conversations: [{ ...address, sessionKey: scope.sessionKey }] }],
            errorMessage: "Conversation owner changed before title commit",
          })
        : undefined;
    const assertCurrent =
      current &&
      (guardKind === "composed"
        ? composeSessionEntryCommitGuards([current.source])
        : current.source);
    if (current) {
      await withoutEntrySql(async () => {
        await rename(scope, "Current owner title", assertCurrent, true);
      }, true);
    }
    const original = getSessionEntry(scope);
    const renaming = patchSessionEntry({
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
    await expect(renaming).rejects.toThrow("Conversation owner changed before title commit");
    expect(getSessionEntry(scope)).toEqual(original);
    expect(getConversationSession(address)).toEqual(
      binding(replacementScope, replacement.sessionId),
    );
    expect(getSessionEntry(replacementScope)).not.toHaveProperty("displayName");
  },
);

it("does not let a later parent turn replace an existing thread owner", async () => {
  const parentKey = "agent:main:reef:group:room";
  const threadKey = `${parentKey}:thread:first`;
  const address = addressFor();
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
        delivery: deliveryFor("room", threadId),
      },
    });
  }
  expect(getConversationSession(address)).toEqual({ sessionKey: threadKey, sessionId: "thread" });
  await deleteSessionEntry({ agentId: "main", sessionKey: threadKey, storePath });
  expect(getConversationSession(address)).toBeUndefined();
});
