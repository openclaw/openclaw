import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecentSessionConversationTextAsync } from "../../gateway/session-transcript-readers.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  bindSessionTranscriptStoreScope,
  resolveSessionKeyBySessionIdAsync,
  resolveSessionTranscriptReadTarget,
  resolveSessionTranscriptRuntimeTarget,
} from "./session-accessor.transcript-target.js";
import { trimSessionTranscriptForManualCompact } from "./session-accessor.transcript.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import { readLatestTranscriptAssistantTextAsync as latestAssistant } from "./session-transcript-assistant-read.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { loadSessionTranscriptEvents as readEvents } from "./session-transcript-events.js";
import { prepareSessionTranscriptHydration as prepareHydration } from "./session-transcript-hydration.js";
import { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { readTranscriptStatsAsync } from "./session-transcript-stats.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import { readRecentUserAssistantTextForSession as recentText } from "./transcript.js";
import type { InternalSessionEntry } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory transcript read opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory transcript read allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-transcript-read" };
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
afterEach(() => memorySessionActorOwners.reset());

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}

function message(id: string, parentId: string | null, role: string, content: string) {
  return {
    type: "message" as const,
    id,
    parentId,
    timestamp: "2026-10-11T00:00:00.000Z",
    message: { role, content },
  };
}
const ids = (events: readonly unknown[]) =>
  events.flatMap((event) => (isRecord(event) ? [event.id] : []));

async function fixture(sessionId = "one", agentId = "main", messages?: TranscriptEvent[]) {
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const owner = memorySessionActorOwners.get({ agentId, path: storePath });
  const sessionKey = `agent:${agentId}:dashboard:incognito-${sessionId}`;
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const storage = actor.storage!;
  const events = [
    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
    ...(messages ?? [
      message("user", null, "user", "Question"),
      message("answer", "user", "assistant", `Answer ${sessionId}`),
    ]),
  ];
  const mutate = async (command: Parameters<typeof storage.mutate>[0]) =>
    committed(await storage.mutate(command, authority));
  await mutate({
    type: "session.entry.create",
    input: { entry: { sessionId, updatedAt: 1, incognito: true }, transcriptEvents: events },
  });
  const scope = { agentId, sessionKey, sessionId, storePath, env };
  const binding = { actor, authority, agentId, path: storePath };
  const append = async ({ message: payload, ...event }: ReturnType<typeof message>) =>
    mutate({
      type: "session.metadata.append",
      input: {
        scope,
        event,
        message: {
          messageJson: JSON.stringify(payload),
          cwd: "/synthetic",
          validateTurn: false,
        },
        options: {},
      },
    });
  const patch = (value: Partial<InternalSessionEntry>) =>
    mutate({ type: "session.entry.patch", input: { operation: { kind: "fields", patch: value } } });
  return { owner, actor, mutate, scope, binding, events, append, patch };
}

describe("memory transcript read adapters", () => {
  it("reads sparse recent user context through the captured owner during a reply append", async () => {
    const { binding, scope, append } = await fixture(
      "snapshot",
      "main",
      Array.from({ length: 300 }, (_, index) =>
        message(
          `snapshot-${index}`,
          index === 0 ? null : `snapshot-${index - 1}`,
          index === 0 || index === 50 ? "user" : "assistant",
          `Context ${index}`,
        ),
      ),
    );
    await runWithSessionActorStorage(binding, async () => {
      const [recent] = await Promise.all([
        recentText({ ...scope, role: "user", limit: 2 }),
        append(message("appended", "snapshot-299", "assistant", "Concurrent reply")),
      ]);
      expect(recent).toEqual([
        { id: "snapshot-0", role: "user", text: "Context 0" },
        { id: "snapshot-50", role: "user", text: "Context 50" },
      ]);
      expect(await latestAssistant(scope)).toMatchObject({
        text: "Concurrent reply",
      });
    });
  });

  it("reads unbound actor writes through bounded generic readers without SQLite", async () => {
    const { scope, events, append } = await fixture();
    expect(bindSessionTranscriptStoreScope(scope).storePath).toBe(scope.storePath);
    expect(resolveSessionTranscriptReadTarget(scope)).toMatchObject(scope);
    expect(await readEvents(scope)).toEqual(events);
    expect(await recentText({ ...scope, role: "assistant", limit: 2 })).toEqual([
      { id: "answer", role: "assistant", text: "Answer one" },
    ]);
    expect(await readTranscriptStatsAsync(scope)).toMatchObject({ eventCount: 3, maxSeq: 2 });
    expect(await readSessionTranscriptWatermarkAsync(scope)).toMatchObject({ maxSeq: 2 });
    expect(await hasSessionTranscriptMessage(scope)).toBe(true);
    expect(await readSessionTranscriptAnchorsAsync(scope, { entryIds: ["answer"] })).toMatchObject({
      anchors: [{ entryId: "answer" }],
    });
    const context = await readSessionTranscriptModelContextAsync(scope, (value) => value);
    expect(ids(context.events)).toContain("answer");

    await expect(readEvents({ ...scope, maxEventBytes: 1 })).rejects.toThrow("too large");
    expect(await latestAssistant(scope)).toMatchObject({
      text: "Answer one",
    });

    let readAfterClose: (() => Promise<unknown>) | undefined;
    await withSessionTranscriptDeltaReader(scope, async (reader) => {
      const initial = await reader.raw({ maxEvents: 3 });
      expect(initial).toMatchObject({ kind: "page", hasMore: false });
      assert(initial.kind === "page");
      const next = message("next", "answer", "assistant", "New answer");
      await append(next);
      expect(await reader.raw({ cursor: initial.cursor, maxEvents: 1 })).toMatchObject({
        kind: "page",
        events: [{ event: next }],
        hasMore: false,
      });
      const visible = await reader.visible({ maxMessages: 1 });
      expect(visible).toMatchObject({ kind: "page", hasMore: true });
      assert(visible.kind === "page");
      expect(visible.events).toHaveLength(1);
      readAfterClose = () => reader.raw({});
    });
    await expect(readAfterClose!()).rejects.toThrow("no longer active");
    expect(await latestAssistant(scope)).toMatchObject({
      text: "New answer",
    });

    const hydration = prepareHydration(scope, { maxBytes: 16384, maxEvents: 1 });
    const bounded = await hydration.read();
    expect(bounded.kind).toBe("bounded");
    expect(ids(bounded.snapshot.events)).toContain("next");
    expect(bounded.snapshot.events.length).toBeLessThanOrEqual(2);
    const cancelled = new AbortController();
    const stopped = prepareHydration(scope, undefined, cancelled.signal);
    cancelled.abort(new Error("caller cancelled"));
    await expect(stopped.read()).rejects.toThrow("caller cancelled");
  });

  it("reads recent text after a reset without leaking older or custom-message context", async () => {
    const { scope } = await fixture("reset", "main", [
      message("before", null, "user", "Before reset"),
      {
        type: "reset",
        id: "boundary",
        parentId: "before",
        reason: "reset",
        timestamp: "2026-10-11T00:00:00.000Z",
      },
      {
        type: "custom_message",
        id: "notice",
        parentId: "boundary",
        customType: "notice",
        content: "Visible control",
        display: true,
        timestamp: "2026-10-11T00:00:00.000Z",
      },
      message("after", "notice", "user", "After marker"),
    ]);
    expect(await recentText({ ...scope, role: "user", limit: 2 })).toEqual([
      { id: "after", role: "user", text: "After marker" },
    ]);
  });

  it("selects sibling and retained historical windows without creating missing sessions", async () => {
    const root = await fixture();
    const sibling = await fixture("two");
    const otherAgent = await fixture("other", "helper");
    const previous = sibling.actor.snapshot(authority)!.entry!;
    await sibling.mutate({
      type: "session.entry.replace",
      input: { expected: previous, entry: { ...previous, sessionId: "two-new" } },
    });
    expect(await readEvents(sibling.scope)).toEqual(sibling.events);
    expect(await readEvents({ ...sibling.scope, sessionKey: undefined })).toEqual(sibling.events);
    expect(await resolveSessionKeyBySessionIdAsync(sibling.scope)).toBe(sibling.scope.sessionKey);
    expect(
      await resolveSessionTranscriptRuntimeTarget(sibling.scope, undefined, {
        keyFormat: "agent-qualified",
      }),
    ).toMatchObject({
      sessionKey: sibling.scope.sessionKey,
      sessionId: "two",
      selectedSessionId: "two-new",
    });
    expect(await readEvents({ ...otherAgent.scope, sessionKey: undefined })).toEqual(
      otherAgent.events,
    );
    const before = root.owner.listSessions(authority).length;
    const missing = { ...root.scope, sessionKey: undefined, sessionId: "missing" };
    expect(await readEvents(missing)).toEqual([]);
    expect(
      await readRecentSessionConversationTextAsync(missing, { role: "user", limit: 2 }),
    ).toEqual([]);
    expect(await latestAssistant(missing)).toBeUndefined();
    expect(await withSessionTranscriptDeltaReader(missing, (reader) => reader.raw({}))).toEqual({
      kind: "missing",
    });
    expect(
      await prepareHydration({
        ...missing,
        sessionKey: root.scope.sessionKey,
      }).read(),
    ).toMatchObject({ kind: "full", snapshot: { events: [] } });
    expect(
      await prepareHydration(
        { ...missing, sessionKey: root.scope.sessionKey },
        { maxBytes: 1024, maxEvents: 1 },
      ).read(),
    ).toMatchObject({ kind: "bounded", snapshot: { events: [], totalEvents: 0 } });
    expect(root.owner.listSessions(authority)).toHaveLength(before);
  });

  it("retains owner close and absence across an unbound reader's lifetime", async () => {
    const { scope } = await fixture();
    const captured = prepareHydration(scope);
    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    const absent = prepareHydration(scope);
    await fixture();
    await expect(captured.read()).rejects.toThrow();
    expect(() => captured.assertCurrent()).toThrow();
    expect(await absent.read()).toMatchObject({ kind: "full", snapshot: { events: [] } });
    expect(await readEvents(scope)).toHaveLength(3);
  });

  it("manually compacts current rows and accounting while preserving a newer entry update", async () => {
    const { scope, owner, patch } = await fixture();
    await patch({
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 30,
      cacheWrite: 40,
      estimatedCostUsd: 0.5,
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 3,
      contextBudgetStatus: contextBudgetStatusFixture({
        route: "compact_only",
        shouldCompact: true,
      }),
      cliSessionIds: { synthetic: "old" },
      cliSessionBindings: { synthetic: { sessionId: "old" } },
      claudeCliSessionId: "old",
    });
    const source: SessionSourceAssertion = Object.assign(() => {}, {
      async prepareSessionSource() {
        await patch({ label: "Updated during preparation", model: "synthetic-model" });
        return { checks: [], assertCurrent() {} };
      },
    });
    await expect(
      trimSessionTranscriptForManualCompact(scope, {
        maxLines: 2,
        nowMs: 500,
        authority: {
          source,
          assertHostCurrent() {},
          expectedLifecycleRevision: owner.readSession(scope.sessionKey, authority)?.entry
            ?.lifecycleRevision,
        },
      }),
    ).resolves.toEqual({ compacted: true, kept: 2 });
    expect(await readEvents(scope)).toMatchObject([
      { type: "session", id: "one" },
      { id: "answer", parentId: null },
    ]);
    const entry = owner.readSession(scope.sessionKey, authority)?.entry;
    expect(entry).toMatchObject({
      label: "Updated during preparation",
      model: "synthetic-model",
      updatedAt: 500,
      compactionCount: 3,
    });
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheRead",
      "cacheWrite",
      "estimatedCostUsd",
      "totalTokens",
      "totalTokensFresh",
      "totalTokensVersion",
      "contextBudgetStatus",
      "cliSessionIds",
      "cliSessionBindings",
      "claudeCliSessionId",
    ] as const) {
      expect(entry?.[field], field).toBeUndefined();
    }
  });

  it("preserves transcript and accounting when bound manual-compaction authority rejects", async () => {
    const { scope, owner, binding, events, patch } = await fixture();
    await patch({ inputTokens: 10, totalTokens: 20, cliSessionIds: { synthetic: "preserved" } });
    const before = owner.readSession(scope.sessionKey, authority)?.entry;
    await expect(
      runWithSessionActorStorage(binding, () =>
        trimSessionTranscriptForManualCompact(scope, {
          maxLines: 2,
          authority: {
            source: () => {
              throw new Error("manual compaction permission withdrawn");
            },
            assertHostCurrent() {},
            expectedLifecycleRevision: before?.lifecycleRevision,
          },
        }),
      ),
    ).rejects.toThrow("manual compaction permission withdrawn");
    expect(await readEvents(scope)).toEqual(events);
    expect(owner.readSession(scope.sessionKey, authority)?.entry).toEqual(before);
  });

  it("carries the current-turn admission fence through all generic reader routes", async () => {
    const { actor, binding, scope, append } = await fixture();
    await append(message("current-user", "answer", "user", "Current input"));
    await append(message("future", "current-user", "assistant", "Future answer"));
    const anchor = actor
      .snapshot(authority)!
      .transcript.anchors.find((entry) => entry.entryId === "current-user");
    assert(anchor);
    const receipt = { ...anchor, role: "user" as const, logicalTurnId: "current-turn" };
    await runWithSessionActorStorage(binding, () =>
      runWithSessionTranscriptReadFence(receipt, async () => {
        expect(ids(await readEvents(scope))).toEqual(["one", "user", "answer"]);
        expect(await latestAssistant(scope)).toMatchObject({
          text: "Answer one",
        });
        const hydrated = await prepareHydration(scope).read();
        expect(ids(hydrated.snapshot.events)).toEqual(["one", "user", "answer"]);
        await withSessionTranscriptDeltaReader(scope, async (reader) => {
          const raw = await reader.raw({});
          assert(raw.kind === "page");
          expect(ids(raw.events.map((row) => row.event))).toEqual(["one", "user", "answer"]);
          const visible = await reader.visible({});
          assert(visible.kind === "page");
          expect(ids(visible.events.map((row) => row.event))).toEqual(["user", "answer"]);
        });
      }),
    );
  });
});
