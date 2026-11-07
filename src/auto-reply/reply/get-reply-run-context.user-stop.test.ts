import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { recordSessionRunStopped, userStopTargetKey } from "../../sessions/session-run-stopped.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { prepareReadyReply } from "./get-reply-run-context.test-support.js";
import { writeSessionStore } from "./test/session.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);
const STOPPED = "The user stopped the previous agent run";
const stopOf = (sessionId: string, at: number) => ({
  sessionId,
  userStoppedAt: at,
  userStoppedSessionId: sessionId,
});

it.each([
  { name: "a user's Stop", entry: stopOf("stopped", 5), aborted: false, stop: true },
  { name: "an interruption", entry: {}, aborted: true, stop: false },
  {
    name: "an interruption, past a Stop carried from another incarnation",
    entry: { ...stopOf("earlier", 5), sessionId: "stopped" },
    aborted: true,
    stop: false,
  },
  { name: "a Stop with no session row", entry: undefined, aborted: true, stop: true },
])("prefixes the next prompt after $name", async ({ entry, aborted, stop }) => {
  const prepared = await prepareReadyReply({
    abortedLastRun: aborted,
    sessionEntry: entry && { sessionId: "stopped", updatedAt: 1, ...entry },
  });
  expect(prepared.prefixedBodyBase.includes(STOPPED)).toBe(stop);
  expect(prepared.prefixedBodyBase.includes("continue the unfinished work")).toBe(!stop);
});

it.each([
  { name: "the Stop it read", stored: stopOf("stopped", 5), says: true, left: undefined },
  // A Stop the row no longer holds is not this prompt's to say, nor an interruption to continue.
  { name: "not a newer Stop", stored: stopOf("stopped", 6), says: false, left: 6 },
  { name: "not a replacement's Stop", stored: stopOf("replacement", 5), says: false, left: 5 },
  { name: "not a Stop whose row is gone", stored: undefined, says: false, left: undefined },
])("claims $name before the prompt says it", async ({ stored, says, left }) => {
  const storePath = path.join(tempDirs.make("openclaw-user-stop-"), "sessions.json");
  const sessionKey = "agent:main:main";
  const rows = Object.fromEntries(stored ? [[sessionKey, { ...stored, updatedAt: 1 }]] : []);
  await writeSessionStore(storePath, rows);
  const sessionEntry = { updatedAt: 1, ...stopOf("stopped", 5) };
  // The in-memory map holds its own copy of the row, as after a concurrent write.
  const sessionStore = structuredClone(rows);
  const prepared = await prepareReadyReply({
    abortedLastRun: true,
    sessionKey,
    storePath,
    sessionStore,
    sessionEntry,
  });
  expect(prepared.prefixedBodyBase.includes(STOPPED)).toBe(says);
  expect(prepared.prefixedBodyBase).not.toContain("continue the unfinished work");
  expect(sessionEntry.userStoppedAt).toBeUndefined();
  expect(sessionStore[sessionKey]?.userStoppedAt).toBe(left);
  expect(loadSessionEntry({ storePath, sessionKey })?.userStoppedAt).toBe(left);
});

it.each([
  { name: "one says it", row: true, saying: 1 },
  { name: "none says a Stop whose row is gone", row: false, saying: 0 },
])("two turns prepared from the same Stop: $name", async ({ row, saying }) => {
  const storePath = path.join(tempDirs.make("openclaw-user-stop-"), "sessions.json");
  const sessionKey = "agent:main:main";
  await writeSessionStore(
    storePath,
    row ? { [sessionKey]: { ...stopOf("stopped", 5), updatedAt: 1 } } : {},
  );
  const prepare = () =>
    prepareReadyReply({
      sessionKey,
      storePath,
      sessionStore: {},
      sessionEntry: { updatedAt: 1, ...stopOf("stopped", 5) },
    });
  const prompts = await Promise.all([prepare(), prepare()]);
  expect(prompts.filter((prompt) => prompt.prefixedBodyBase.includes(STOPPED))).toHaveLength(
    saying,
  );
});

it("claims a global session's Stop from the store its agent recorded it in", async () => {
  // A fixed shared locator gives each agent its own file; the `global` key names no agent.
  const storePath = path.join(tempDirs.make("openclaw-user-stop-"), "shared-sessions.json");
  const work = { agentId: "work", storePath, sessionKey: "global" };
  const stopped = { ...work, sessionId: "stopped" };
  await replaceSessionEntry(work, { sessionId: "stopped", updatedAt: 1, lastRunId: "run-1" });
  await recordSessionRunStopped(
    { stoppedAt: 5, sessions: [stopped] },
    { runIds: new Map([[userStopTargetKey(stopped) ?? "", new Set(["run-1"])]]) },
  );
  const sessionEntry = loadSessionEntry(work);
  expect(sessionEntry?.userStoppedAt).toBe(5);
  const prepared = await prepareReadyReply({
    agentId: "work",
    abortedLastRun: true,
    sessionKey: "global",
    storePath,
    sessionStore: {},
    sessionEntry,
  });
  expect(prepared.prefixedBodyBase).toContain(STOPPED);
  expect(loadSessionEntry(work)?.userStoppedAt).toBeUndefined();
});

it("keeps a row stored before user Stops existed an interruption to continue", async () => {
  const storePath = path.join(tempDirs.make("openclaw-user-stop-"), "sessions.json");
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  // An earlier release's row: an interrupted run and no user-Stop fields.
  await writeSessionStore(storePath, {
    [scope.sessionKey]: { sessionId: "old", updatedAt: 1, abortedLastRun: true },
  });
  const sessionEntry = loadSessionEntry(scope);
  expect(sessionEntry).toMatchObject({ sessionId: "old", abortedLastRun: true });
  expect(sessionEntry).not.toHaveProperty("userStoppedAt");
  expect(sessionEntry).not.toHaveProperty("userStoppedSessionId");
  const prepared = await prepareReadyReply({
    agentId: "main",
    abortedLastRun: sessionEntry?.abortedLastRun === true,
    sessionKey: scope.sessionKey,
    storePath,
    sessionStore: {},
    sessionEntry,
  });
  expect(prepared.prefixedBodyBase).toContain("continue the unfinished work");
  expect(prepared.prefixedBodyBase).not.toContain(STOPPED);
  expect(loadSessionEntry(scope)).toEqual(sessionEntry);
});
