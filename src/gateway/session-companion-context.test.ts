import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion } from "./session-companion.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  // Worker leases still need these databases until asynchronous cleanup settles.
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  memorySessionActorOwners.reset();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

function createScope(prefix: string) {
  const stateDir = tempDirs.make(prefix);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({});
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionId: `${prefix}-session`,
    sessionKey: `agent:main:${prefix}`,
  };
}

async function seedScope(prefix: string) {
  const scope = createScope(prefix);
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return scope;
}

function turn(
  eventId: string,
  parentId: string | null,
  role: "user" | "assistant" | "toolResult",
  content: string,
  timestamp: number,
) {
  return { eventId, parentId, message: { role, content, timestamp } };
}

function chain(
  count: number,
  message: (index: number) => readonly [Parameters<typeof turn>[2], string],
  prefix = "message",
  parentId: string | null = null,
) {
  return Array.from({ length: count }, (_, i) =>
    turn(`${prefix}-${i}`, i ? `${prefix}-${i - 1}` : parentId, ...message(i), i),
  );
}

const persist = (
  scope: ReturnType<typeof createScope>,
  messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"],
) => persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: true });

const ready = (scope: ReturnType<typeof createScope>, messages: unknown[]) => ({
  kind: "ready",
  context: { empty: messages.length === 0, messages, sessionId: scope.sessionId },
});
const compact = (scope: ReturnType<typeof createScope>, details?: { payload: string }) =>
  appendTranscriptEvent(scope, {
    type: "compaction",
    id: "compaction",
    parentId: "retained",
    timestamp: "2026-08-11T00:00:00.000Z",
    summary: "older context was compacted",
    firstKeptEntryId: "retained",
    tokensBefore: 100,
    ...(details ? { details } : {}),
  });

async function readReady(scope: ReturnType<typeof createScope>) {
  const result = await defaultSessionCompanionContextReader.read(scope);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") {
    throw new Error("Expected ready companion context");
  }
  return result.context.messages;
}

it("reads replaced session identities without host SQL", async () => {
  const scope = createScope("companion-context-identity");
  for (const sessionId of [scope.sessionId, `${scope.sessionId}-replacement`]) {
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    const hostSql = observeHostDataSql();
    try {
      await expect(defaultSessionCompanionContextReader.currentSessionId(scope)).resolves.toBe(
        sessionId,
      );
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
  }
});

it.each(
  [false, true].flatMap((warm) =>
    (["reset", "dispose", "request-abort", "backing-reset"] as const).map((cancellation) => ({
      warm,
      cancellation,
    })),
  ),
)(
  "cancels $cancellation before prepared context resumes (warm=$warm)",
  async ({ warm, cancellation }) => {
    const scope = await seedScope(`companion-cancel-${cancellation}-${warm}`);
    const run = vi.fn(async () => "Existing answer.");
    const service = createSessionCompanion({
      scheduler: createTestGatewayScheduler(createGatewaySchedulerClock(123).clock),
      getConfig: () => ({}),
      contextReader: defaultSessionCompanionContextReader,
      sessionObserver: {
        getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }),
      },
      resolveUtilityModelRef: () => "openai/gpt-5.6-luna",
      run,
    });
    const request = {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      question: "Why?",
      connId: "conn-1",
    };
    try {
      if (warm) {
        await service.ask(request);
      }
      const controller = new AbortController();
      const pending = service
        .ask({ ...request, signal: controller.signal })
        .catch((error: unknown) => error);
      if (cancellation === "reset") {
        service.reset(request);
      } else if (cancellation === "dispose") {
        service.dispose();
      } else if (cancellation === "backing-reset") {
        notifyGatewaySessionReset(scope.sessionKey, scope.agentId);
      } else {
        controller.abort();
      }
      await expect(pending).resolves.toMatchObject({
        reason: cancellation === "backing-reset" ? "context-unavailable" : "unavailable",
        message:
          cancellation === "backing-reset"
            ? "The selected session changed before Side chat could answer."
            : cancellation === "reset"
              ? "The Side chat request was cancelled."
              : "Side chat could not answer right now.",
      });
      expect(run).toHaveBeenCalledTimes(warm ? 1 : 0);
      expect(service.state(request)).toEqual({
        exchanges:
          warm && cancellation === "request-abort"
            ? [{ question: "Why?", answer: "Existing answer.", ts: 123 }]
            : [],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      service.dispose();
    }
  },
);

it("distinguishes a missing session from an empty selected transcript", async () => {
  const scope = createScope("companion-context-empty");
  await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
    kind: "missing",
  });

  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  expect(await defaultSessionCompanionContextReader.read(scope)).toEqual(ready(scope, []));
});

it("reads current incognito context without creating missing sessions", async () => {
  const scope = {
    ...createScope("companion-memory"),
    sessionKey: "agent:main:dashboard:incognito-companion",
  };
  const location = {
    agentId: scope.agentId,
    path: resolveIncognitoOpenClawAgentSqlitePath(scope),
  };
  expect(await defaultSessionCompanionContextReader.read(scope)).toEqual({ kind: "missing" });
  expect(memorySessionActorOwners.read(location)).toBeUndefined();
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    incognito: true,
  });
  expect(await defaultSessionCompanionContextReader.currentSessionId(scope)).toBe(scope.sessionId);
  for (const [index, text] of ["First question", "Latest question"].entries()) {
    await persist(scope, [
      {
        eventId: `question-${index}`,
        message: { role: "user", content: text, timestamp: index },
      },
    ]);
    expect(await defaultSessionCompanionContextReader.read(scope)).toMatchObject({
      kind: "ready",
      context: {
        sessionId: scope.sessionId,
        messages: expect.arrayContaining([{ role: "user", text, ts: index }]),
      },
    });
  }
  memorySessionActorOwners.closeDatabase(location);
  expect(await defaultSessionCompanionContextReader.read(scope)).toEqual({ kind: "missing" });
  expect(await defaultSessionCompanionContextReader.currentSessionId(scope)).toBeUndefined();
});

it("reads a bounded active SQLite tail without decoding old transcript rows", async () => {
  const scope = await seedScope("companion-context-tail");
  await persist(
    scope,
    chain(201, (i) => [i % 2 === 0 ? "user" : "assistant", `message ${i}`]),
  );

  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  database.db
    .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
    .run(scope.sessionId);

  const messages = await readReady(scope);
  expect(messages).toHaveLength(40);
  expect([messages.at(0), messages.at(-1)]).toEqual([
    { role: "assistant", text: "message 161", ts: 161 },
    { role: "user", text: "message 200", ts: 200 },
  ]);
});

it("pages past a tool-heavy tail while retaining the selected session's latest user turn", async () => {
  const scope = await seedScope("companion-context-tools");
  await persist(
    scope,
    chain(451, (i) => [
      i === 450 ? "user" : i >= 50 ? "toolResult" : i % 2 ? "assistant" : "user",
      i === 450 ? "visible latest question" : `${i < 50 ? "useful" : "tool result"} ${i}`,
    ]),
  );

  const messages = await readReady(scope);
  expect(messages).toHaveLength(40);
  expect(messages.at(-1)?.text).toBe("visible latest question");
  expect(messages.some((message) => message.text.startsWith("tool result"))).toBe(false);
});

it("keeps complete recent context when older tool rows exhaust the scan byte budget", async () => {
  const scope = await seedScope("companion-context-byte-budget");
  await persist(scope, [
    turn("older-tool", null, "toolResult", "x".repeat(200_000), -1),
    ...chain(
      128,
      (i) => [i % 9 === 0 ? "user" : "toolResult", i % 9 === 0 ? `useful ${i}` : "x".repeat(7800)],
      "recent",
      "older-tool",
    ),
  ]);

  const messages = await readReady(scope);
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.at(-1)?.text).toBe("useful 126");
  expect(messages.every((message) => message.text.startsWith("useful"))).toBe(true);
});

it.each([
  { expectedKind: "ready", unsupportedCount: 4095 },
  { expectedKind: "unavailable", unsupportedCount: 4096 },
] as const)(
  "fails closed only when unsupported roles exceed the bounded scan ($unsupportedCount)",
  async ({ expectedKind, unsupportedCount }) => {
    const scope = await seedScope(`companion-context-unsupported-${unsupportedCount}`);
    const messages = [
      turn("visible-user", null, "user", "authoritative question", 1),
      ...Array.from({ length: unsupportedCount }, (_, index) => ({
        eventId: `custom-${index}`,
        parentId: index === 0 ? "visible-user" : `custom-${index - 1}`,
        message: {
          role: "custom" as const,
          customType: "test-context",
          content: `unsupported ${index}`,
          timestamp: index + 2,
        },
      })),
    ];
    await persist(scope, messages);

    const result = await defaultSessionCompanionContextReader.read(scope);

    expect(result.kind).toBe(expectedKind);
    if (result.kind === "ready") {
      expect(result.context.messages.map((message) => message.text)).toEqual([
        "authoritative question",
      ]);
    }
  },
);

it("returns unavailable instead of backfilling past an oversized latest user message", async () => {
  const scope = await seedScope("companion-context-oversized-latest");
  await persist(scope, [
    turn("older", null, "user", "stale older question", 1),
    turn("oversized", "older", "user", "x".repeat(1024 * 1024), 2),
  ]);

  await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
    kind: "unavailable",
  });
});

it("uses the contiguous newest suffix when an older message exceeds the read budget", async () => {
  const scope = await seedScope("companion-context-oversized-older");
  await persist(scope, [
    turn("stale", null, "user", "stale older question", 1),
    turn("oversized", "stale", "assistant", "x".repeat(1024 * 1024), 2),
    turn("recent-question", "oversized", "user", "recent question", 3),
    turn("recent-answer", "recent-question", "assistant", "recent answer", 4),
  ]);

  const hostSql = observeHostDataSql();
  const result = await defaultSessionCompanionContextReader
    .read(scope)
    .finally(() => hostSql.restore());
  expect(hostSql.queries).toEqual([]);
  expect(result).toEqual(
    ready(scope, [
      { role: "user", text: "recent question", ts: 3 },
      { role: "assistant", text: "recent answer", ts: 4 },
    ]),
  );
});

it("keeps transcript-visible messages across compaction", async () => {
  const scope = await seedScope("companion-context-compaction");
  await persist(scope, [
    turn("discarded", null, "user", "discarded context", 1),
    turn("retained", "discarded", "user", "retained context", 2),
  ]);
  await compact(scope);
  await persist(scope, [
    turn("answer", "compaction", "assistant", "recent answer", 3),
    turn("question", "answer", "user", "visible current question", 4),
  ]);

  const messages = await readReady(scope);
  expect(messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "discarded context"],
    ["user", "retained context"],
    ["assistant", "recent answer"],
    ["user", "visible current question"],
  ]);
});

it("ignores oversized non-message compaction details", async () => {
  const scope = await seedScope("companion-context-oversized-boundary");
  await persist(scope, [turn("retained", null, "user", "retained context", 1)]);
  await compact(scope, { payload: "x".repeat(1024 * 1024) });

  await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual(
    ready(scope, [{ role: "user", text: "retained context", ts: 1 }]),
  );
});

it("returns unavailable rather than an empty context while the active projection is stale", async () => {
  const scope = await seedScope("companion-context-unavailable");
  await persist(scope, [turn("question", null, "user", "visible question", 1)]);
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);

  await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
    kind: "unavailable",
  });
});
