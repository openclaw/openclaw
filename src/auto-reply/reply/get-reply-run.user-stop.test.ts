import "./get-reply-run.runtime-mocks.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runPreparedReply } from "./get-reply-run.js";
import {
  baseParams,
  createInboundBody,
  createSessionBody,
  nonReasoningModelState,
} from "./get-reply-run.test-support.js";
import { writeSessionStore } from "./test/session.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);
beforeEach(() => vi.mocked(runReplyAgent).mockClear());
const STOPPED = "The user stopped the previous agent run";
const stopOf = (sessionId: string, at: number) => ({
  sessionId,
  userStoppedAt: at,
  userStoppedSessionId: sessionId,
});
const storeOf = (name = "sessions.json") => path.join(tempDirs.make("openclaw-user-stop-"), name);
/** Runs one reply turn: the body its model receives, or undefined when no model runs. */
async function promptOf(overrides: Parameters<typeof baseParams>[0]) {
  const calls = vi.mocked(runReplyAgent).mock.calls.length;
  await runPreparedReply(baseParams(overrides));
  return vi.mocked(runReplyAgent).mock.calls[calls]?.[0].commandBody;
}

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
  const prompt = await promptOf({
    abortedLastRun: aborted,
    sessionEntry: entry && { sessionId: "stopped", updatedAt: 1, ...entry },
  });
  expect(prompt?.includes(STOPPED)).toBe(stop);
  expect(prompt?.includes("continue the unfinished work")).toBe(!stop);
});

it.each([
  { name: "the Stop it read", stored: stopOf("stopped", 5), says: true, left: undefined },
  // A Stop the row no longer holds is not this turn's to say, nor an interruption to continue.
  { name: "not a newer Stop", stored: stopOf("stopped", 6), says: false, left: 6 },
  { name: "not a replacement's Stop", stored: stopOf("replacement", 5), says: false, left: 5 },
  { name: "not a Stop whose row is gone", stored: undefined, says: false, left: undefined },
])("claims $name before the prompt says it", async ({ stored, says, left }) => {
  const storePath = storeOf();
  const sessionKey = "agent:main:main";
  const rows = Object.fromEntries(stored ? [[sessionKey, { ...stored, updatedAt: 1 }]] : []);
  await writeSessionStore(storePath, rows);
  const sessionEntry = { updatedAt: 1, ...stopOf("stopped", 5) };
  // The in-memory map holds its own copy of the row, as after a concurrent write.
  const sessionStore = structuredClone(rows);
  const prompt = await promptOf({
    abortedLastRun: true,
    sessionKey,
    storePath,
    sessionStore,
    sessionEntry,
  });
  expect(prompt?.includes(STOPPED)).toBe(says);
  expect(prompt).not.toContain("continue the unfinished work");
  expect(sessionEntry.userStoppedAt).toBeUndefined();
  expect(sessionStore[sessionKey]?.userStoppedAt).toBe(left);
  expect(loadSessionEntry({ storePath, sessionKey })?.userStoppedAt).toBe(left);
});

it.each([
  { name: "one says it", row: true, saying: 1 },
  { name: "none says a Stop whose row is gone", row: false, saying: 0 },
])("two turns admitted from the same Stop: $name", async ({ row, saying }) => {
  const storePath = storeOf();
  const sessionKey = "agent:main:main";
  const stored = { [sessionKey]: { ...stopOf("stopped", 5), updatedAt: 1 } };
  await writeSessionStore(storePath, row ? stored : {});
  const turn = () =>
    runPreparedReply(
      baseParams({
        sessionKey,
        storePath,
        sessionStore: {},
        sessionEntry: { updatedAt: 1, ...stopOf("stopped", 5) },
      }),
    );
  await Promise.all([turn(), turn()]);
  const bodies = vi.mocked(runReplyAgent).mock.calls.map((call) => call[0].commandBody);
  expect(bodies).toHaveLength(2);
  expect(bodies.filter((body) => body.includes(STOPPED))).toHaveLength(saying);
});

it("keeps a recorded Stop for the next turn when one is refused before any model", async () => {
  const storePath = storeOf();
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  await writeSessionStore(storePath, {
    [scope.sessionKey]: { ...stopOf("stopped", 5), updatedAt: 1 },
  });
  const turn = (overrides: Parameters<typeof baseParams>[0] = {}) =>
    promptOf({
      ...scope,
      abortedLastRun: true,
      sessionStore: {},
      sessionEntry: loadSessionEntry(scope),
      ...overrides,
    });
  // Admission answers an unsupported explicit thinking level itself; no model runs.
  const refused = await turn({
    provider: "openai",
    model: "chat-latest",
    modelState: nonReasoningModelState(),
    resolvedThinkLevel: "xhigh",
    opts: { thinkingLevelOverride: "xhigh" },
  });
  expect(refused).toBeUndefined();
  expect(loadSessionEntry(scope)?.userStoppedAt).toBe(5);
  const prompt = await turn();
  expect(prompt).toContain(STOPPED);
  expect(prompt).not.toContain("continue the unfinished work");
  expect(loadSessionEntry(scope)?.userStoppedAt).toBeUndefined();
});

it("reads the think hint ahead of a recorded Stop's note", async () => {
  // The note joins the body only at admission, after the hint was read and removed.
  await runPreparedReply(
    baseParams({
      ctx: createInboundBody("low Run this"),
      sessionCtx: createSessionBody("low Run this"),
      resolvedThinkLevel: undefined,
      sessionEntry: { updatedAt: 1, ...stopOf("stopped", 5) },
    }),
  );
  const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
  expect(call?.followupRun.run.thinkLevel).toBe("low");
  expect(call?.commandBody).toMatch(new RegExp(`^Note: ${STOPPED}\\..*\\n\\nRun this$`, "su"));
});

it("claims a global session's Stop from the store its agent recorded it in", async () => {
  // A fixed shared locator gives each agent its own file; the `global` key names no agent.
  const storePath = storeOf("shared-sessions.json");
  const work = { agentId: "work", storePath, sessionKey: "global" };
  await replaceSessionEntry(work, { ...stopOf("stopped", 5), updatedAt: 1 });
  const sessionEntry = loadSessionEntry(work);
  expect(sessionEntry?.userStoppedAt).toBe(5);
  const prompt = await promptOf({
    agentId: "work",
    abortedLastRun: true,
    sessionKey: "global",
    storePath,
    sessionStore: {},
    sessionEntry,
  });
  expect(prompt).toContain(STOPPED);
  expect(loadSessionEntry(work)?.userStoppedAt).toBeUndefined();
});

it("keeps an old-shaped stored row's interruption a run to continue", async () => {
  const storePath = storeOf();
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  // The row shape an earlier release stored: an interrupted run, no user-Stop fields.
  await writeSessionStore(storePath, {
    [scope.sessionKey]: { sessionId: "old", updatedAt: 1, abortedLastRun: true },
  });
  const sessionEntry = loadSessionEntry(scope);
  expect(sessionEntry).toMatchObject({ sessionId: "old", abortedLastRun: true });
  expect(sessionEntry).not.toHaveProperty("userStoppedAt");
  expect(sessionEntry).not.toHaveProperty("userStoppedSessionId");
  const prompt = await promptOf({
    ...scope,
    abortedLastRun: sessionEntry?.abortedLastRun === true,
    sessionStore: {},
    sessionEntry,
  });
  expect(prompt).toContain("continue the unfinished work");
  expect(prompt).not.toContain(STOPPED);
  expect(loadSessionEntry(scope)).not.toHaveProperty("userStoppedAt");
});
