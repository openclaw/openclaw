/** Tests the claim `prepareReplyAgentTurn` makes for a turn admitted to run after a user's Stop. */
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import { createPreparationRun } from "./reply-agent-turn-preparation.test-support.js";
import { claimUserStopForAdmittedTurn } from "./reply-user-stop.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);
const stopOf = (sessionId: string, at: number) => ({
  sessionId,
  updatedAt: 1,
  userStoppedAt: at,
  userStoppedSessionId: sessionId,
});
/** Stores `stored` (if any) and returns turns admitted to run on that session. */
async function admitted(params: {
  stored?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  preflightError?: Error;
}) {
  const { agentId = "main", sessionKey = "agent:main:main" } = params;
  const storePath = path.join(tempDirs.make("openclaw-user-stop-"), "sessions.json");
  if (params.stored) {
    await replaceSessionEntry({ agentId, storePath, sessionKey }, params.stored);
  }
  const scope = { agentId, storePath, sessionKey };
  // Each turn read the session while it held the Stop at 5.
  const turn = (read = stopOf("stopped", 5)) => {
    // The in-memory map holds its own copy of the row, as after a concurrent write.
    const sessionStore = params.stored ? { [sessionKey]: { ...params.stored } } : {};
    const published: Array<SessionEntry | undefined> = [];
    const session = { kind: "session" as const, key: sessionKey, storePath, current: () => read };
    return {
      published,
      sessionStore,
      claim: () =>
        claimUserStopForAdmittedTurn({
          queued: createPreparationRun({ run: { agentId } }),
          session: { ...session, publish: (entry) => void published.push(entry) },
          sessionStore,
          preflightError: params.preflightError,
        }),
    };
  };
  return { scope, turn };
}

it.each([
  { name: "the Stop it read", stored: stopOf("stopped", 5), wins: true, left: undefined },
  { name: "not a newer Stop", stored: stopOf("stopped", 6), wins: false, left: 6 },
  { name: "not a replacement's Stop", stored: stopOf("replacement", 5), wins: false, left: 5 },
  { name: "not a Stop whose row is gone", stored: undefined, wins: false, left: undefined },
])("claims $name", async ({ stored, wins, left }) => {
  const { scope, turn } = await admitted({ stored });
  const admittedTurn = turn();
  expect(await admittedTurn.claim()).toBe(wins);
  // Only the winner's copies drop the Stop; a loser's could clobber a newer one.
  expect(admittedTurn.published.map((entry) => entry?.userStoppedAt)).toEqual(
    wins ? [undefined] : [],
  );
  expect(admittedTurn.sessionStore[scope.sessionKey]?.userStoppedAt).toBe(left);
  expect(loadSessionEntry(scope)?.userStoppedAt).toBe(left);
});

it("lets one of two racing turns claim a Stop, and no later goal step", async () => {
  const { turn } = await admitted({ stored: stopOf("stopped", 5) });
  const raced = await Promise.all([turn().claim(), turn().claim()]);
  expect(raced.toSorted()).toEqual([false, true]);
  // A goal continuation admitted after the claiming turn read the same Stop.
  expect(await turn().claim()).toBe(false);
});

it("claims a global session's Stop from the store its agent recorded it in", async () => {
  // A fixed shared locator gives each agent its own file; the `global` key names no agent.
  const work = { agentId: "work", sessionKey: "global" };
  const { scope, turn } = await admitted({ ...work, stored: stopOf("stopped", 5) });
  expect(await turn().claim()).toBe(true);
  expect(loadSessionEntry(scope)?.userStoppedAt).toBeUndefined();
});

it("leaves the Stop to a later turn when preflight failed", async () => {
  const preflightError = new Error("preflight failed");
  const { scope, turn } = await admitted({ stored: stopOf("stopped", 5), preflightError });
  expect(await turn().claim()).toBe(false);
  expect(loadSessionEntry(scope)?.userStoppedAt).toBe(5);
});

it("claims a Stop with no session row from the command's abort memory, once", async () => {
  setAbortMemory("rowless", true);
  const claim = () =>
    claimUserStopForAdmittedTurn({
      queued: { ...createPreparationRun(), abortKey: "rowless" },
      session: { kind: "detached", current: () => undefined, publish: () => {} },
    });
  expect(await claim()).toBe(true);
  expect(getAbortMemory("rowless")).not.toBe(true);
  expect(await claim()).toBe(false);
});
