import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  appendTranscriptEvent,
  listSessionEntriesCore,
  upsertSessionEntryCore,
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import * as sessionEntryWriter from "../config/sessions/session-entry-patch.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { setDisplayName, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  appendSessionYieldContext,
  formatSessionTranscriptMemoryHitKey,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  withSessionTranscriptWriteLock,
  type SessionTranscriptReadParams,
  createSessionCatalogGitHubLinker,
  createSessionCatalogSourceActorProjector,
  readSessionTranscriptCatalogPage,
  readSessionTranscriptCatalogTitle,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  let state: OpenClawTestState;
  let storePath: string;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
    storePath = state.path("sessions.json");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  async function createScope(sessionId = "session") {
    const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 10 });
    return scope;
  }
  const entries = (scope: SessionTranscriptReadParams) =>
    readVisibleSessionTranscriptMessageEntries(scope);
  const append = (scope: SessionTranscriptReadParams, role: string, content: string) =>
    appendSessionTranscriptMessageByIdentity({ ...scope, message: { role, content } });

  it("appends keyed mirrors, dedupes unkeyed mirrors, and rejects a rebound session", async () => {
    const scope = await createScope();
    for (const idempotencyKey of ["delivery-1", "delivery-2"]) {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          idempotencyKey,
          deliveryMirror: { kind: "channel-final", sourceMessageId: idempotencyKey },
          text: "visible assistant reply",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    }
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toBeUndefined();
    expect(await entries(scope)).toHaveLength(2);
    const unkeyed = await createScope("unkeyed");
    const request = { ...unkeyed, text: "unkeyed assistant reply" };
    const first = await appendAssistantMirrorMessageByIdentity(request);
    expect(first).toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(await entries(unkeyed)).toHaveLength(1);
    await expect(
      appendAssistantMirrorMessageByIdentity({ ...scope, text: "stale reply" }),
    ).resolves.toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("does not append an assistant mirror after cancellation", async () => {
    const scope = await createScope();
    const cancellation = new Error("cancelled by user");
    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        signal: AbortSignal.abort(cancellation),
        text: "must not be persisted",
      }),
    ).rejects.toBe(cancellation);
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it.each(["assistant mirror", "yield context"])(
    "rejects %s after its admitted writer is superseded",
    async (operation) => {
      const scope = await createScope();
      await upsertSessionEntryCore(scope, {
        activeWriterRunId: "replacement-run",
        lifecycleRevision: "revision-a",
        sessionId: scope.sessionId,
        updatedAt: 10,
      });
      await expect(
        withOwnedSessionTranscriptWrites(
          {
            sessionKey: scope.sessionKey,
            sessionTarget: {
              ...scope,
              expectedLifecycleRevision: "revision-a",
              expectedWriterRunId: "superseded-run",
            },
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            if (operation === "yield context") {
              await appendSessionYieldContext({
                ...scope,
                message: "must not be persisted",
                assertCurrent: () => {},
              });
            } else {
              await appendAssistantMirrorMessageByIdentity({
                ...scope,
                idempotencyKey: "superseded:fallback",
                text: "must not be persisted",
              });
            }
          },
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    },
  );

  it("rechecks yield settlement authority after waiting for the transcript writer", async () => {
    const scope = await createScope();
    let active = true;
    const stopped = new Error("yield settlement stopped");
    const writerEntered = createDeferredCore();
    const releaseWriter = createDeferredCore();
    const heldWriter = withSessionTranscriptWriteLock(scope, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;
    try {
      const write = appendSessionYieldContext({
        ...scope,
        message: "private continuation",
        assertCurrent: () => {
          if (!active) {
            throw stopped;
          }
        },
      });
      const rejected = expect(write).rejects.toBe(stopped);
      active = false;
      releaseWriter.resolve();
      await heldWriter;
      await rejected;
    } finally {
      releaseWriter.resolve();
      await heldWriter;
    }
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("dedupes unkeyed assistant mirrors against only the visible SQLite branch", async () => {
    const scope = await createScope();
    const active = await append(scope, "assistant", "visible branch reply");
    const inactive = await append(scope, "assistant", "inactive mirror reply");
    assert(active && inactive);
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active",
      parentId: inactive.messageId,
      targetId: active.messageId,
    });
    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "inactive mirror reply",
    });
    assert(result.ok);
    expect(result.messageId).not.toBe(inactive.messageId);
    await expect(readSessionTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({ id: inactive.messageId }),
    );
    expect(await entries(scope)).toMatchObject([
      { entryId: active.messageId },
      { entryId: result.messageId },
    ]);
  });

  it("serializes caller-checked idempotency inside scoped locked appends", async ({ signal }) => {
    const scope = await createScope("caller-checked-lock-session");
    const steps: string[] = [];
    const firstRead = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const secondTargetRead = createDeferredCore();
    const secondQueued = createDeferredCore();
    const read = projectionLane.pool.run.bind(projectionLane.pool);
    let targetReads = 0;
    vi.spyOn(projectionLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await read(...args);
      if (
        reply.ok &&
        typeof reply.value !== "boolean" &&
        !Array.isArray(reply.value) &&
        reply.value.kind === "session-runtime-target"
      ) {
        if (++targetReads === 1) {
          await secondTargetRead.promise;
        } else if (targetReads === 2) {
          secondTargetRead.resolve();
          await firstRead.promise;
        }
      }
      return reply;
    });
    const enqueueWrite = sessionEntryWriter.runSessionEntryWorkerOperation;
    let queuedWrites = 0;
    vi.spyOn(sessionEntryWriter, "runSessionEntryWorkerOperation").mockImplementation((params) => {
      const pending = enqueueWrite(params);
      // Preparation reserves the existing FIFO before this worker owner first yields.
      if (params.candidateKind === "session-transcript-locked" && ++queuedWrites === 2) {
        secondQueued.resolve();
      }
      return pending;
    });
    let enteredWrites = 0;
    const appendIfMissing = async () =>
      await withSessionTranscriptWriteLock(scope, async (locked) => {
        // Target preparation can finish out of order before either caller acquires the lock.
        const label = ++enteredWrites === 1 ? "first" : "second";
        steps.push(`${label}:read`);
        const events = await locked.readEvents();
        const alreadyAppended = events.some((event) => {
          const message = (event as { message?: { idempotencyKey?: unknown } }).message;
          return message?.idempotencyKey === "mirror-once";
        });
        if (label === "first") {
          firstRead.resolve();
          await releaseFirst.promise;
        }
        if (!alreadyAppended) {
          await locked.appendMessage({
            idempotencyLookup: "caller-checked",
            message: {
              role: "assistant",
              content: [{ type: "text", text: label }],
              idempotencyKey: "mirror-once",
              timestamp: 1,
            },
          });
        }
        steps.push(`${label}:done`);
      });

    const first = appendIfMissing();
    const second = appendIfMissing();
    const writes = Promise.all([first, second]);
    try {
      await withinTest(
        Promise.race([Promise.all([firstRead.promise, secondQueued.promise]), writes]),
        signal,
      );
      expect(steps).toEqual(["first:read"]);
    } finally {
      secondTargetRead.resolve();
      firstRead.resolve();
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
    await writes;

    expect(targetReads).toBe(2);
    expect(steps).toEqual(["first:read", "first:done", "second:read", "second:done"]);
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(1);
  });

  it("does not publish queued locked updates when the callback throws", async () => {
    const scope = await createScope();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    await expect(
      withSessionTranscriptWriteLock(scope, async (locked) => {
        await locked.appendMessage({
          message: { role: "assistant", content: "durable but failed", timestamp: 1 },
        });
        await locked.publishUpdate({ sessionKey: scope.sessionKey });
        throw new Error("stop before commit");
      }),
    ).rejects.toThrow("stop before commit");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(await entries(scope)).toMatchObject([
      { message: { role: "assistant", content: "durable but failed" } },
    ]);
  });

  it("resolves encoded memory hit keys by agent and opaque session id instead of transcript basename", async () => {
    const scope = await createScope("my-plugin:task/1");
    await upsertSessionEntryCore(scope, {
      sessionFile: state.path("legacy-file-name.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const key = formatSessionTranscriptMemoryHitKey(scope);
    expect(key).toBe("transcript:main:my-plugin%3Atask%2F1");
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        key,
        store: Object.fromEntries(
          listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
        ),
      }),
    ).toEqual([scope.sessionKey]);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "deleted-session",
    });
    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store: {} })).toEqual([
      "agent:main:deleted-session",
    ]);
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        includeSyntheticFallback: false,
        key,
        store: {},
      }),
    ).toEqual([]);
  });
});

const source = { pluginId: "session-share", sourceDomain: "source-node" };
const scope = { agentId: "main", sessionKey: "agent:main:shared", sessionId: "shared-session" };
const read = (limit: number, cursor?: string) =>
  readSessionTranscriptCatalogPage({ ...scope, ...source, limit, cursor });

async function seed(messages: unknown[]) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const [index, message] of messages.entries()) {
    await appendTranscriptMessage(scope, {
      eventId: `message-${index}`,
      message,
      now: 1000 + index,
    });
  }
}

describe("native transcript catalog SDK", () => {
  it("pages only user and assistant text newest-first without opening a writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "Visible question" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "First answer part" },
            { type: "thinking", thinking: "Reasoning" },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
            { type: "output_text", text: "Second answer part" },
            { type: "tool_result", content: "Embedded tool result" },
            { type: "reasoning", text: "More reasoning" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "image", text: "Image metadata" },
            { type: "text", text: " \n " },
            { type: "text", text: "NO_REPLY" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [{ type: "text", text: "Tool result" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Answer" }] },
        { role: "tool", content: "Tool role" },
        { role: "tool_result", content: [{ type: "text", text: "Other tool role" }] },
        { role: "system", content: "System instructions" },
        { role: "custom", content: [{ type: "text", text: "Unknown role" }] },
        { role: "user", content: [{ type: "tool_result", content: "User tool result" }] },
        { role: "assistant", content: "   " },
        { role: "assistant", content: "NO_REPLY" },
      ]);
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const before = fs.readFileSync(databasePath);
      const first = await read(2);
      expect(first.items.map((item) => [item.type, item.text])).toEqual([
        ["agentMessage", "Answer"],
        ["agentMessage", "Second answer part"],
      ]);
      const second = await read(1, first.nextCursor);
      expect(second.items).toMatchObject([{ type: "agentMessage", text: "First answer part" }]);
      const third = await read(2, second.nextCursor);
      expect(third.items.map((item) => [item.type, item.text])).toEqual([
        ["userMessage", "Visible question"],
      ]);
      expect(third.nextCursor).toBeUndefined();
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
    });
  });

  it("redacts before clipping text and derives the same human title as local sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "A useful session title" },
        {
          role: "assistant",
          content: `Authorization: Bearer synthetic-secret-token\n${"x".repeat(9000)}`,
        },
      ]);
      const page = await read(1);
      expect(page.items[0]).toMatchObject({ type: "agentMessage", truncated: true });
      expect(page.items[0]?.text).not.toContain("synthetic-secret-token");
      expect(page.items[0]?.text?.length).toBeLessThanOrEqual(6000);
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error("missing fixture entry");
      }
      expect(readSessionTranscriptCatalogTitle({ ...scope, entry })).toBe("A useful session title");
      expect(
        readSessionTranscriptCatalogTitle({
          ...scope,
          entry: { ...entry, label: "Named", displayName: "Display" },
        }),
      ).toBe("Named");
    });
  });

  it("keeps older-item cursors stable across append and rejects malformed or foreign cursors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(["one", "two", "three"].map((content) => ({ role: "user", content })));
      const first = await read(2);
      if (!first.nextCursor) {
        throw new Error("missing fixture cursor");
      }
      const mixedProjectionCursor = JSON.parse(
        Buffer.from(first.nextCursor, "base64url").toString("utf8"),
      );
      // Before the text-only projection, cursor offsets also counted tools and thinking.
      mixedProjectionCursor.scope = createHash("sha256")
        .update(
          JSON.stringify([
            scope.agentId,
            scope.sessionKey,
            scope.sessionId,
            resolveSessionStorePathForScope(scope),
          ]),
        )
        .digest("base64url");
      await expect(
        read(2, Buffer.from(JSON.stringify(mixedProjectionCursor)).toString("base64url")),
      ).rejects.toThrow("no longer matches");
      await appendTranscriptMessage(scope, {
        eventId: "message-3",
        message: { role: "user", content: "four" },
      });
      const next = await read(2, first.nextCursor);
      expect(next.items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, "not-a-cursor")).rejects.toThrow("Invalid session transcript cursor");
      for (const limit of [0, 201, 1.5, Number.NaN]) {
        await expect(read(limit)).rejects.toThrow("limit must be an integer");
      }
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:other" },
        { sessionId: "other-session", updatedAt: 1 },
      );
      await expect(
        readSessionTranscriptCatalogPage({
          ...source,
          agentId: "main",
          sessionKey: "agent:main:other",
          limit: 2,
          cursor: first.nextCursor,
        }),
      ).rejects.toThrow("no longer matches");
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "rewind",
        parentId: "message-3",
        targetId: "message-0",
      });
      // The source writer owns rewind reconciliation; catalog reads cannot rebuild it.
      await reconcileSessionTranscriptIndexes({ agentId: scope.agentId });
      expect((await read(2)).items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
      for (const [eventId, parentId] of [
        ["replacement-two", "message-0"],
        ["replacement-three", "replacement-two"],
      ] as const) {
        await appendTranscriptMessage(scope, {
          eventId,
          parentId,
          message: { role: "user", content: eventId },
        });
      }
      // Equal-length branch replacements must not reuse the old ordinal as an anchor.
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
    });
  });

  it("exports portable senders and creators, linking only verified numeric GitHub identities on opt-in", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const github = syncGitHubIdentity({
        identity: { accountId: 12345, login: "portable-user", name: "Portable User" },
        authenticationAlias: { kind: "github-login", login: "portable-user" },
      });
      const local = ensureProfileForEmail("local@example.test");
      setDisplayName(local.id, "Local User");
      const observation = {
        type: "observation",
        pluginId: "fixture",
        accountId: null,
        senderKind: "human",
        id: "external-user",
      };
      await seed([
        {
          role: "user",
          content: "GitHub",
          __openclaw: { senderIdentity: { type: "profile", id: github.id } },
        },
        {
          role: "user",
          content: "Local",
          __openclaw: { senderIdentity: { type: "profile", id: local.id } },
        },
        {
          role: "user",
          content: "Observed",
          __openclaw: { senderIdentity: observation, senderName: "Observed User" },
        },
      ]);
      const page = await read(10);
      expect(page.items.map((item) => item.sender)).toEqual([
        { identity: observation, label: "Observed User" },
        {
          identity: {
            type: "remote",
            pluginId: source.pluginId,
            domain: source.sourceDomain,
            idKind: "profile",
            id: local.id,
          },
          label: "Local User",
        },
        {
          identity: {
            type: "remote",
            pluginId: source.pluginId,
            domain: source.sourceDomain,
            idKind: "github-account",
            id: "12345",
          },
          label: "Portable User",
        },
      ]);
      const sender = page.items[2]?.sender;
      if (!sender) {
        throw new Error("missing GitHub sender");
      }
      const linker = createSessionCatalogGitHubLinker();
      expect(linker.linkParticipant(sender)).toMatchObject({
        identity: { type: "profile", id: github.id },
        label: "Portable User",
      });
      const unmatched = {
        ...sender,
        identity: {
          type: "remote" as const,
          pluginId: "fixture",
          domain: "elsewhere",
          idKind: "github-account",
          id: "999",
        },
      };
      expect(linker.linkParticipant(unmatched)).toEqual(unmatched);
      expect(linker.resolveOwner("github:PORTABLE-USER")).toMatchObject({
        type: "human",
        id: github.id,
        identity: { type: "profile", id: github.id },
      });
      expect(linker.resolveOwner(`profile:${local.id}`)).toMatchObject({
        id: local.id,
        label: "Local User",
      });
      expect(linker.resolveOwner("github:missing")).toBeUndefined();
      const newlyVerified = syncGitHubIdentity({
        identity: { accountId: 999, login: "newly-verified", name: "Newly Verified" },
        authenticationAlias: { kind: "github-login", login: "newly-verified" },
      });
      expect(linker.linkParticipant(unmatched)).toEqual(unmatched);
      expect(linker.resolveOwner("github:newly-verified")).toBeUndefined();
      const nextPageLinker = createSessionCatalogGitHubLinker();
      expect(nextPageLinker.linkParticipant(unmatched)).toMatchObject({
        identity: { type: "profile", id: newlyVerified.id },
      });
      expect(nextPageLinker.resolveOwner("github:newly-verified")).toMatchObject({
        id: newlyVerified.id,
      });
      const projectActor = createSessionCatalogSourceActorProjector({
        ...source,
        actors: [{ type: "human", source: "profile", id: github.id }],
      });
      expect(projectActor({ type: "human", source: "profile", id: github.id })).toMatchObject({
        type: "human",
        identity: sender.identity,
        label: "Portable User",
      });
      expect(
        projectActor({ type: "human", source: "channel", id: github.id })?.identity,
      ).toBeUndefined();
      expect(projectActor({ type: "agent", id: "main", label: "Main" })).toEqual({
        type: "agent",
        id: "main",
        label: "Main",
      });
    });
  });
});
