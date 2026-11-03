import { describe, expect, it } from "vitest";
import {
  projectSessionLifecyclePatch,
  type SessionLifecyclePatchInput,
} from "./session-run-lifecycle-projection.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const entry: SessionEntry = {
  sessionId: "goal-session",
  lifecycleRevision: "goal-revision",
  lifecycleRunId: "goal-run",
  activeWriterRunId: "goal-run",
  updatedAt: 1_000,
  startedAt: 1_000,
  goal: {
    schemaVersion: 1,
    id: "goal-1",
    objective: "Finish the work",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    tokenStart: 0,
    tokensUsed: 12,
    continuationTurns: 2,
  },
};
const stopped: SessionLifecyclePatchInput = {
  canonicalKey: "agent:main:goal",
  currentLifecycleGeneration: "generation-1",
  lifecycleRevision: entry.lifecycleRevision,
  exactCronRun: false,
  expectedWriter: {
    runId: "goal-run",
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
  },
  event: {
    sessionId: entry.sessionId,
    runId: "goal-run",
    lifecycleGeneration: "generation-1",
    ts: 2_000,
    data: {
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason: "rpc",
      startedAt: 1_000,
      endedAt: 2_000,
    },
  },
};

describe("Goal terminal lifecycle projection", () => {
  it.each(["rpc", "aborted"])("atomically pauses unfinished work after %s Stop", (stopReason) => {
    const result = projectSessionLifecyclePatch(entry, {
      ...stopped,
      event: { ...stopped.event, data: { ...stopped.event.data, stopReason } },
    });
    expect(result.patch).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      goal: {
        ...entry.goal,
        status: "paused",
        pausedAt: 2_000,
        updatedAt: 2_000,
        lastStatusNote: "Paused after Stop. Resume to continue.",
      },
    });
    expect(result.effects?.failedRun).toBeUndefined();
  });

  it.each([
    { phase: "end", stopReason: "restart", aborted: true },
    { phase: "end", stopReason: "superseded", aborted: true },
    { phase: "end", stopReason: "stop" },
    { phase: "end", yielded: true, livenessState: "waiting" },
  ])("preserves pursuit for $stopReason / $livenessState", (data) => {
    const result = projectSessionLifecyclePatch(entry, {
      ...stopped,
      event: { ...stopped.event, data: { startedAt: 1_000, endedAt: 2_000, ...data } },
    });
    expect(result.patch?.goal).toBeUndefined();
  });

  it("does not pause the executing Goal when a queued sibling stops before execution", () => {
    const result = projectSessionLifecyclePatch(entry, {
      ...stopped,
      expectedWriter: undefined,
      event: {
        ...stopped.event,
        runId: "queued-run",
        data: { ...stopped.event.data, executionStarted: false, startedAt: undefined },
      },
    });
    expect(result.patch).toBeNull();
  });

  it("does not let a stale Stop pause a newer session, writer, or Goal", () => {
    for (const replacement of [
      { ...entry, sessionId: "new-session" },
      { ...entry, lifecycleRevision: "new-revision" },
      { ...entry, lifecycleRunId: "new-run", activeWriterRunId: "new-run", startedAt: 2_500 },
      { ...entry, goal: { ...entry.goal!, updatedAt: 2_500 } },
      {
        ...entry,
        goal: { ...entry.goal!, id: "replacement-goal", createdAt: 2_500, updatedAt: 2_500 },
      },
    ]) {
      expect(projectSessionLifecyclePatch(replacement, stopped).patch?.goal).toBeUndefined();
    }
  });
});
