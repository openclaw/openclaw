import fs from "node:fs";
import { serialize } from "node:v8";
import { expect } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { commitMemory } from "./session-actor-memory-publication.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { test } from "./session-entry-fixture.test-support.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { readPromptCacheRecoveryKeysInWorker } from "./session-prompt-cache-recovery.js";

const since = 10_000;
const ping = {
  anchorEntryId: "reply",
  provider: "test",
  model: "test",
  lastPingAt: since,
  pings: 1,
};

test("recovers the same warm keys across pages without returning cold session metadata", async ({
  store,
}) => {
  expect(await readPromptCacheRecoveryKeysInWorker(store.store, since)).toEqual([]);
  for (let index = 0; index < 130; index++) {
    const key = "agent:main:row-" + String(index).padStart(3, "0");
    writeSessionEntry(store.database, key, {
      sessionId: key,
      updatedAt: since + 1,
      lastActivityAt: index === 64 ? since : since - 1,
      ...(index === 129 ? { promptCacheKeepWarm: ping } : {}),
      label: "stored label ".repeat(100),
    });
  }
  for (const key of [
    "agent:main:cron:timer:run:tick",
    "agent:main:subagent:background",
    "agent:main:acp:other",
  ]) {
    writeSessionEntry(store.database, key, {
      sessionId: key,
      updatedAt: since,
      lastActivityAt: since,
    });
  }
  // A preserved ping does not advance the writer's activity column. Raw imports may also
  // leave that column newer or older than the activity in the actual list projection.
  store.database.db
    .prepare("UPDATE session_nodes SET last_activity_at = ? WHERE session_key = ?")
    .run(1, "agent:main:row-064");
  store.database.db
    .prepare("UPDATE session_nodes SET last_activity_at = ? WHERE session_key = ?")
    .run(since, "agent:main:row-000");
  const { baseline, candidate } = await withSessionStoreReaderInWorker(
    store.store,
    async ({ reader, database, continuation }) => {
      const scope = { agentId: database.agentId, storePath: database.path, env: database.env };
      return {
        baseline: await reader.readEntries(
          { ...scope, projection: "list", hydrateSkillPromptRefs: false },
          continuation,
        ),
        candidate: await reader.readEntries({ ...scope, promptCacheSince: since }, continuation),
      };
    },
    { backing: true, dataOnly: true },
  );
  const keys = await readPromptCacheRecoveryKeysInWorker(store.store, since);
  expect(keys).toEqual(["agent:main:row-064", "agent:main:row-129"]);
  const oldRecovery = baseline.entries
    .filter(
      ({ sessionKey, entry }) =>
        sessionKey.includes(":row-") &&
        Math.max(entry.lastActivityAt ?? 0, entry.promptCacheKeepWarm?.lastPingAt ?? 0) >= since,
    )
    .map(({ sessionKey }) => sessionKey);
  expect(baseline.entries).toHaveLength(133);
  expect(keys).toEqual(oldRecovery);
  expect(candidate.entries).toEqual([]);
  expect(candidate.promptCacheKeys).toEqual(keys);
  expect(serialize(candidate).length).toBeLessThan(serialize(baseline).length);
});

test("still rejects a cold delivery alias before releasing any candidate keys", async ({
  store,
}) => {
  const warm = "agent:main:aaa";
  writeSessionEntry(store.database, warm, {
    sessionId: warm,
    updatedAt: since,
    lastActivityAt: since,
  });
  const sibling = "agent:main:matrix:channel:!mixed:example.org";
  writeSessionEntry(store.database, sibling, { sessionId: sibling, updatedAt: 1 });
  expect(await readPromptCacheRecoveryKeysInWorker(store.store, since)).toEqual([warm]);
  markCanonicalSessionValidationPending(store.database, [sibling]);
  store.database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
    JSON.stringify({
      sessionId: sibling,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "matrix", to: "!Mixed:example.org" },
      }),
    }),
    sibling,
  );
  store.database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sibling);
  await expect(readPromptCacheRecoveryKeysInWorker(store.store, since)).rejects.toThrow(
    "non-canonical persisted row",
  );
});

test("reads the selected memory actor without creating a disk store", async ({ state }) => {
  const target = {
    agentId: "main",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    env: state.env,
  };
  expect(await readPromptCacheRecoveryKeysInWorker(target, since)).toEqual([]);
  const owner = memorySessionActorOwners.get({ agentId: target.agentId, path: target.storePath });
  const sessionKey = "agent:main:dashboard:incognito-warm";
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    await commitMemory(
      actor.storage!,
      "session.entry.create",
      {
        entry: { sessionId: "warm", updatedAt: 1, incognito: true, promptCacheKeepWarm: ping },
        transcriptEvents: [],
      },
      { authorize() {}, assertCurrent() {} },
    );
    expect(await readPromptCacheRecoveryKeysInWorker(target, since)).toEqual([sessionKey]);
    expect(fs.existsSync(target.storePath)).toBe(false);
  } finally {
    await actor.release();
    owner.close();
  }
});
