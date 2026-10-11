import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  bindSessionTranscriptStoreScope,
  resolveSessionKeyBySessionIdAsync,
  resolveSessionTranscriptReadTarget,
  resolveSessionTranscriptRuntimeTarget,
} from "./session-accessor.transcript-target.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import { readLatestTranscriptAssistantTextAsync } from "./session-transcript-assistant-read.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

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
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-11T00:00:00.000Z",
    message: { role, content },
  };
}
const ids = (events: readonly unknown[]) =>
  events.flatMap((event) => (isRecord(event) ? [event.id] : []));

async function fixture(sessionId = "one", agentId = "main") {
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const owner = memorySessionActorOwners.get({ agentId, path: storePath });
  const sessionKey = `agent:${agentId}:dashboard:incognito-${sessionId}`;
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const storage = actor.storage!;
  const events = [
    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
    message("user", null, "user", "Question"),
    message("answer", "user", "assistant", `Answer ${sessionId}`),
  ];
  committed(
    await storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: 1, incognito: true }, transcriptEvents: events },
      },
      authority,
    ),
  );
  const scope = { agentId, sessionKey, sessionId, storePath, env };
  const binding = { actor, authority, agentId, path: storePath };
  const append = async (event: unknown) =>
    committed(
      await storage.mutate(
        {
          type: "session.metadata.append",
          input: { scope, event: JSON.stringify(event), options: {} },
        },
        authority,
      ),
    );
  return { owner, actor, storage, scope, binding, events, append };
}

describe("memory transcript read adapters", () => {
  it("reads committed actor writes through bounded generic readers without SQLite", async () => {
    const { binding, scope, events, append } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      expect(bindSessionTranscriptStoreScope(scope).storePath).toBe(scope.storePath);
      expect(resolveSessionTranscriptReadTarget(scope)).toMatchObject(scope);
      expect(await loadTranscriptEvents(scope)).toEqual(events);
      await expect(loadTranscriptEvents({ ...scope, maxEventBytes: 1 })).rejects.toThrow(
        "too large",
      );
      expect(await readLatestTranscriptAssistantTextAsync(scope)).toMatchObject({
        text: "Answer one",
      });

      let readAfterClose: (() => Promise<unknown>) | undefined;
      await withSessionTranscriptDeltaReader(scope, async (reader) => {
        const initial = await reader.raw({ maxEvents: 3 });
        expect(initial).toMatchObject({ kind: "page", hasMore: false });
        if (initial.kind !== "page") {
          throw new Error("Expected raw page");
        }
        const next = message("next", "answer", "assistant", "New answer");
        await append(next);
        expect(await reader.raw({ cursor: initial.cursor, maxEvents: 1 })).toMatchObject({
          kind: "page",
          events: [{ event: next }],
          hasMore: false,
        });
        const visible = await reader.visible({ maxMessages: 1 });
        expect(visible).toMatchObject({ kind: "page", hasMore: true });
        if (visible.kind !== "page") {
          throw new Error("Expected visible page");
        }
        expect(visible.events).toHaveLength(1);
        readAfterClose = () => reader.raw({});
      });
      await expect(readAfterClose!()).rejects.toThrow("no longer active");
      expect(await readLatestTranscriptAssistantTextAsync(scope)).toMatchObject({
        text: "New answer",
      });

      const hydration = prepareSessionTranscriptHydration(scope, { maxBytes: 16384, maxEvents: 1 });
      const bounded = await hydration.read();
      expect(bounded.kind).toBe("bounded");
      expect(ids(bounded.snapshot.events)).toContain("next");
      expect(bounded.snapshot.events.length).toBeLessThanOrEqual(2);
      const cancelled = new AbortController();
      const stopped = prepareSessionTranscriptHydration(scope, undefined, cancelled.signal);
      cancelled.abort(new Error("caller cancelled"));
      await expect(stopped.read()).rejects.toThrow("caller cancelled");
    });
  });

  it("selects sibling and retained historical windows without creating missing sessions", async () => {
    const root = await fixture();
    const sibling = await fixture("two");
    const otherAgent = await fixture("other", "helper");
    const previous = sibling.actor.snapshot(authority)!.entry!;
    committed(
      await sibling.storage.mutate(
        {
          type: "session.entry.replace",
          input: { expected: previous, entry: { ...previous, sessionId: "two-new" } },
        },
        authority,
      ),
    );
    await runWithSessionActorStorage(root.binding, async () => {
      expect(await loadTranscriptEvents(sibling.scope)).toEqual(sibling.events);
      expect(await loadTranscriptEvents({ ...sibling.scope, sessionKey: undefined })).toEqual(
        sibling.events,
      );
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
      expect(await loadTranscriptEvents({ ...otherAgent.scope, sessionKey: undefined })).toEqual(
        otherAgent.events,
      );
      const before = root.owner.listSessions(authority).length;
      const missing = { ...root.scope, sessionKey: undefined, sessionId: "missing" };
      expect(await loadTranscriptEvents(missing)).toEqual([]);
      expect(await readLatestTranscriptAssistantTextAsync(missing)).toBeUndefined();
      expect(await withSessionTranscriptDeltaReader(missing, (reader) => reader.raw({}))).toEqual({
        kind: "missing",
      });
      expect(
        await prepareSessionTranscriptHydration({
          ...missing,
          sessionKey: root.scope.sessionKey,
        }).read(),
      ).toMatchObject({ kind: "full", snapshot: { events: [] } });
      expect(
        await prepareSessionTranscriptHydration(
          { ...missing, sessionKey: root.scope.sessionKey },
          { maxBytes: 1024, maxEvents: 1 },
        ).read(),
      ).toMatchObject({ kind: "bounded", snapshot: { events: [], totalEvents: 0 } });
      expect(root.owner.listSessions(authority)).toHaveLength(before);
    });
  });

  it("carries the current-turn admission fence through all generic reader routes", async () => {
    const { actor, binding, scope, append } = await fixture();
    await append(message("current-user", "answer", "user", "Current input"));
    await append(message("future", "current-user", "assistant", "Future answer"));
    const anchor = actor
      .snapshot(authority)!
      .transcript.anchors.find((entry) => entry.entryId === "current-user");
    if (!anchor) {
      throw new Error("Missing current input anchor");
    }
    const receipt = { ...anchor, role: "user" as const, logicalTurnId: "current-turn" };
    await runWithSessionActorStorage(binding, () =>
      runWithSessionTranscriptReadFence(receipt, async () => {
        expect(ids(await loadTranscriptEvents(scope))).toEqual(["one", "user", "answer"]);
        expect(await readLatestTranscriptAssistantTextAsync(scope)).toMatchObject({
          text: "Answer one",
        });
        const hydrated = await prepareSessionTranscriptHydration(scope).read();
        expect(ids(hydrated.snapshot.events)).toEqual(["one", "user", "answer"]);
        await withSessionTranscriptDeltaReader(scope, async (reader) => {
          const raw = await reader.raw({});
          if (raw.kind !== "page") {
            throw new Error("Expected raw page");
          }
          expect(ids(raw.events.map((row) => row.event))).toEqual(["one", "user", "answer"]);
          const visible = await reader.visible({});
          if (visible.kind !== "page") {
            throw new Error("Expected visible page");
          }
          expect(ids(visible.events.map((row) => row.event))).toEqual(["user", "answer"]);
        });
      }),
    );
  });
});
