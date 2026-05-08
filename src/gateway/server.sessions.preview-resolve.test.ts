import path from "node:path";
import { expect, test } from "vitest";
import { listSessionEntries, type SessionEntry } from "../config/sessions.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { rpcReq, testState, seedGatewaySessionEntries } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  getMainPreviewEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function seedTranscript(params: {
  sessionId: string;
  transcriptPath: string;
  events: unknown[];
  agentId?: string;
}) {
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId ?? "main",
    sessionId: params.sessionId,
    transcriptPath: params.transcriptPath,
    events: params.events,
  });
}

function seedTranscriptLines(
  sessionId: string,
  transcriptPath: string,
  lines: string[],
  agentId?: string,
) {
  seedTranscript({
    sessionId,
    transcriptPath,
    agentId,
    events: lines.map((line) => JSON.parse(line) as unknown),
  });
}

function seedRawSessionStore(store: Record<string, unknown>) {
  const databases = new Map<string, ReturnType<typeof openOpenClawAgentDatabase>>();
  const getDatabase = (agentId: string) => {
    const existing = databases.get(agentId);
    if (existing) {
      return existing;
    }
    const database = openOpenClawAgentDatabase({ agentId });
    database.db.prepare("DELETE FROM session_entries").run();
    databases.set(agentId, database);
    return database;
  };
  for (const [key, value] of Object.entries(store)) {
    const entry = value as SessionEntry;
    const agentId = parseAgentSessionKey(key)?.agentId ?? "main";
    const database = getDatabase(agentId);
    const insert = database.db.prepare(`
      INSERT INTO session_entries (session_key, entry_json, updated_at)
      VALUES (?, ?, ?)
    `);
    insert.run(key, JSON.stringify(entry), entry.updatedAt ?? Date.now());
  }
}

test("sessions.preview returns transcript previews", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const lines = createToolSummaryPreviewTranscriptLines(sessionId);
  seedTranscriptLines(sessionId, transcriptPath, lines);

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry(sessionId),
    },
  });

  const preview = await directSessionReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>("sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  expect(entry?.items.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
  expect(entry?.items[1]?.text).toContain("call weather");
});

test("sessions.preview resolves legacy mixed-case main alias with custom mainKey", async () => {
  const { dir } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };
  const sessionId = "sess-legacy-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: sessionId }),
    JSON.stringify({ message: { role: "assistant", content: "Legacy alias transcript" } }),
  ];
  seedTranscriptLines(sessionId, transcriptPath, lines, "ops");
  seedRawSessionStore({
    "agent:ops:MAIN": {
      sessionId,
      updatedAt: Date.now(),
    },
  });

  const { ws } = await openClient();
  const entry = await getMainPreviewEntry(ws);
  expect(entry?.items[0]?.text).toContain("Legacy alias transcript");

  ws.close();
});

test("sessions.preview prefers the freshest duplicate row for a legacy mixed-case main alias", async () => {
  const { dir } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };

  const staleTranscriptPath = path.join(dir, "sess-stale-main.jsonl");
  const freshTranscriptPath = path.join(dir, "sess-fresh-main.jsonl");
  seedTranscript({
    sessionId: "sess-stale-main",
    transcriptPath: staleTranscriptPath,
    agentId: "ops",
    events: [
      { type: "session", version: 1, id: "sess-stale-main" },
      { message: { role: "assistant", content: "stale preview" } },
    ],
  });
  seedTranscript({
    sessionId: "sess-fresh-main",
    transcriptPath: freshTranscriptPath,
    agentId: "ops",
    events: [
      { type: "session", version: 1, id: "sess-fresh-main" },
      { message: { role: "assistant", content: "fresh preview" } },
    ],
  });
  seedRawSessionStore({
    "agent:ops:work": {
      sessionId: "sess-stale-main",
      updatedAt: 1,
    },
    "agent:ops:WORK": {
      sessionId: "sess-fresh-main",
      updatedAt: 2,
    },
  });

  const { ws } = await openClient();
  const entry = await getMainPreviewEntry(ws);
  expect(entry?.items[0]?.text).toContain("fresh preview");

  ws.close();
});

test("sessions.resolve and mutators use canonical main key without cleaning legacy ghost keys", async () => {
  const { dir } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };
  const sessionId = "sess-alias-cleanup";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  seedTranscript({
    sessionId,
    transcriptPath,
    agentId: "ops",
    events: Array.from({ length: 8 }).map((_, idx) => ({
      type: "message",
      id: `line-${idx}`,
      message: { role: "assistant", content: `line ${idx}` },
    })),
  });

  const writeRawStore = async (store: Record<string, unknown>) => {
    seedRawSessionStore(store);
  };
  const readStore = async () =>
    Object.fromEntries(
      listSessionEntries({ agentId: "ops" }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    ) as Record<string, Record<string, unknown>>;

  await writeRawStore({
    "agent:ops:work": { sessionId, updatedAt: Date.now() },
    "agent:ops:MAIN": { sessionId, updatedAt: Date.now() - 2_000 },
    "agent:ops:Main": { sessionId, updatedAt: Date.now() - 1_000 },
  });

  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    key: "main",
  });
  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:ops:work");
  let store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual([
    "agent:ops:MAIN",
    "agent:ops:Main",
    "agent:ops:work",
  ]);

  await writeRawStore({
    ...store,
    "agent:ops:MAIN": { ...store["agent:ops:work"] },
  });
  const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
    key: "main",
    thinkingLevel: "medium",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:ops:work");
  store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual([
    "agent:ops:MAIN",
    "agent:ops:Main",
    "agent:ops:work",
  ]);
  expect(store["agent:ops:work"]?.thinkingLevel).toBe("medium");

  await writeRawStore({
    ...store,
    "agent:ops:MAIN": { ...store["agent:ops:work"] },
  });
  const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
    key: "main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual([
    "agent:ops:MAIN",
    "agent:ops:Main",
    "agent:ops:work",
  ]);

  await writeRawStore({
    ...store,
    "agent:ops:MAIN": { ...store["agent:ops:work"] },
  });
  const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:ops:work");
  store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual([
    "agent:ops:MAIN",
    "agent:ops:Main",
    "agent:ops:work",
  ]);

  ws.close();
});

test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
    "agent:main:subagent:target": {
      sessionId: "sess-target-exact",
      updatedAt: now - 20_000,
    },
  };
  for (let i = 0; i < 9; i += 1) {
    entries[`agent:main:subagent:noisy-${i}`] = {
      sessionId: `sess-noisy-${i}`,
      updatedAt: now - i * 1_000,
      label: `sess-target-exact noisy ${i}`,
    };
  }
  await seedGatewaySessionEntries({ entries });

  const { ws } = await openClient();
  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-target-exact",
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:main:subagent:target");
});

test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await seedGatewaySessionEntries({
    entries: {
      "agent:main:subagent:visible-parent": {
        sessionId: "sess-visible-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:hidden-parent": {
        sessionId: "sess-hidden-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:shared-child-key-filter": {
        sessionId: "sess-shared-child-key-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:hidden-parent",
      },
    },
  });

  const { ws } = await openClient();
  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:subagent:shared-child-key-filter",
    spawnedBy: "agent:main:subagent:visible-parent",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toContain(
    "No session found: agent:main:subagent:shared-child-key-filter",
  );
});
