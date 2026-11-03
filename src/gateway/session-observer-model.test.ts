import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  defaultPersistDigest,
  normalizeSessionObserverModelOutput,
  synthesizeSessionObserverTerminalDigest,
  type SessionObserverState,
} from "./session-observer-model.js";
import { createSessionObserverDigestPersister } from "./session-observer-persistence.js";

afterEach(() => vi.restoreAllMocks());

const scope = { agentId: "main", sessionKey: "agent:main:session-1" };
const sessionId = "session-1";
function digest(revision: number): SessionObserverDigest {
  return {
    sessionKey: scope.sessionKey,
    runId: "run-1",
    revision,
    updatedAt: 0,
    headline: "Checking files",
    health: "on-track",
  };
}

function storeFixture(storePath?: string) {
  const target = { ...scope, ...(storePath ? { storePath } : {}) };
  const changes: SessionRowChange[] = [];
  onTestFinished(sessionChanges.subscribe((change) => changes.push(change)));
  return {
    changes,
    seed: (entry: Partial<SessionEntry> = {}) =>
      upsertSessionEntryCore(target, { sessionId, updatedAt: 0, ...entry }),
    read: () => loadSessionEntryReadOnly(target),
    persist: (
      value: SessionObserverDigest,
      options: Partial<Parameters<typeof defaultPersistDigest>[0]> = {},
    ) => defaultPersistDigest({ ...target, sessionId, digest: value, ...options }),
  };
}

function withStore(
  run: (fixture: ReturnType<typeof storeFixture>) => Promise<void>,
  configured = false,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
    setRuntimeConfigSnapshot({});
    await run(
      storeFixture(configured ? fixture.path("observer-sessions", "sessions.json") : undefined),
    );
  });
}

function observeRows() {
  const changes: SessionRowChange[] = [];
  onTestFinished(sessionChanges.subscribe((change) => changes.push(change)));
  return changes;
}

function observerState(overrides: Partial<SessionObserverState> = {}): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    ...scope,
    sessionId,
    runId: "run-1",
    startedAt: 0,
    lastActivityAt: 0,
    lastRunAt: 0,
    revision: 0,
    digestCount: 0,
    consecutiveFailures: 0,
    lastDigestNoteSequence: 0,
    inFlight: false,
    finalPending: false,
    ...overrides,
  };
}

const modelDigest = {
  headline: "Checking the fix",
  assessment: "Tests are passing.",
  health: "on-track",
  planProgress: { completed: 2, total: 3 },
};
const json = JSON.stringify(modelDigest);
it.each([
  ["raw JSON", json],
  ["mixed-case label and whitespace", ` \n\`\`\`JsOn \r\n ${json} \r\n\`\`\`\t`],
])("normalizes %s", (_label, text) => {
  expect(normalizeSessionObserverModelOutput(text)).toEqual(modelDigest);
});
it("rejects leading prose", () => {
  expect(normalizeSessionObserverModelOutput(`Here is the digest: ${json}`)).toBeNull();
});

it("returns null without publication when the session row is gone", () =>
  withStore(async ({ persist, changes }) => {
    expect(await persist(digest(1), { sessionId: undefined })).toBeNull();
    expect(changes).not.toContainEqual(expect.objectContaining(scope));
  }));

it.each([
  ["stale revision", 2, 1, { sessionId }],
  ["session id mismatch", 1, 2, { sessionId: "other" }],
  ["superseded run", 0, 1, { sessionId, stillCurrent: () => false }],
] as const)(
  "rejects %s without changing or publishing the row",
  (_label, seedRevision, revision, options) =>
    withStore(async ({ seed, read, persist, changes }) => {
      await seed({ observerDigest: digest(seedRevision), updatedAt: 1 });
      changes.length = 0;
      expect(await persist(digest(revision), options)).toBe(false);
      expect(changes).not.toContainEqual(expect.objectContaining(scope));
      expect(read()?.observerDigest?.revision).toBe(seedRevision);
    }),
);

it.each([
  [false, undefined],
  [false, "lifecycle-a"],
  [true, undefined],
  [true, "lifecycle-a"],
] as const)(
  "store configured=%s rejects old lifecycle %s after same-id reset",
  (configured, lifecycleRevision) =>
    withStore(async ({ seed, read, persist, changes }) => {
      await seed({ lifecycleRevision: "lifecycle-b", updatedAt: 1 });
      changes.length = 0;
      expect(await persist({ ...digest(10), sessionId, lifecycleRevision })).toBe(false);
      expect(changes).not.toContainEqual(expect.objectContaining(scope));
      expect(read()?.observerDigest).toBeUndefined();
      const current = { ...digest(1), sessionId, lifecycleRevision: "lifecycle-b" };
      expect(await persist(current)).toBe(true);
      expect(changes).toContainEqual(expect.objectContaining(scope));
      expect(read()?.observerDigest).toEqual(current);
      if (configured) {
        expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      }
    }, configured),
);

it("publishes a live/preamble persist", () =>
  withStore(async ({ seed }) => {
    await seed();
    const changes = observeRows();
    vi.spyOn(Date, "now").mockReturnValue(0);
    const persist = createSessionObserverDigestPersister({
      persistDigest: defaultPersistDigest,
      stillCurrent: () => () => true,
      onMissingEntry: () => {},
      onError: () => {},
    });
    await persist(observerState(), digest(1), true);
    expect(changes).toContainEqual(expect.objectContaining(scope));
  }));

it("publishes terminal-digest synthesis through the same seam", () =>
  withStore(async ({ seed, read }) => {
    await seed();
    const changes = observeRows();
    vi.spyOn(Date, "now").mockReturnValue(1);
    const terminal = await synthesizeSessionObserverTerminalDigest({
      source: { state: observerState({ previousDigest: digest(1), terminalHealth: "done" }) },
      readSession: read,
      persistDigest: defaultPersistDigest,
    });
    expect(terminal?.health).toBe("done");
    expect(changes).toContainEqual(expect.objectContaining(scope));
  }));
