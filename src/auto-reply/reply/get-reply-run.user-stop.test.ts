import "./get-reply-run.runtime-mocks.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams } from "./get-reply-run.test-support.js";
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
  { name: "a user's Stop", entry: stopOf("stopped", 5), aborted: false, interrupted: false },
  { name: "an interruption", entry: {}, aborted: true, interrupted: true },
  {
    name: "an interruption, past a Stop carried from another incarnation",
    entry: { ...stopOf("earlier", 5), sessionId: "stopped" },
    aborted: true,
    interrupted: true,
  },
  { name: "a Stop with no session row", entry: undefined, aborted: true, interrupted: false },
])("leaves the note to the turn that runs after $name", async ({ entry, aborted, interrupted }) => {
  const prompt = await promptOf({
    abortedLastRun: aborted,
    sessionEntry: entry && { sessionId: "stopped", updatedAt: 1, ...entry },
  });
  // A Stop is never an interruption to continue; the turn admitted to run states it.
  expect(prompt?.includes("continue the unfinished work")).toBe(interrupted);
  expect(prompt).not.toContain(STOPPED);
  // A Stop with no row is claimed later from the command's abort memory.
  expect(vi.mocked(runReplyAgent).mock.calls[0]?.[0].followupRun.abortKey).toBe("session-key");
});

it("admits a turn without claiming its recorded Stop", async () => {
  const storePath = storeOf();
  const scope = { agentId: "main", storePath, sessionKey: "agent:main:main" };
  await writeSessionStore(storePath, {
    [scope.sessionKey]: { ...stopOf("stopped", 5), updatedAt: 1 },
  });
  // Routing may still answer, refuse, skip or steer this turn without running its prompt.
  await promptOf({ ...scope, sessionStore: {}, sessionEntry: loadSessionEntry(scope) });
  expect(loadSessionEntry(scope)?.userStoppedAt).toBe(5);
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
