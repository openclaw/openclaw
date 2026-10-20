import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import * as sessionEntryWriter from "../config/sessions/session-entry-patch.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
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
  appendAssistantMirrorMessageByIdentity as appendMirror,
  appendSessionTranscriptMessageByIdentity as appendByIdentity,
  appendSessionYieldContext,
  formatSessionTranscriptMemoryHitKey as formatHitKey,
  readLatestAssistantTextByIdentity as readLatestText,
  readSessionTranscriptEvents as readEvents,
  readVisibleSessionTranscriptMessageEntries as readEntries,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys as resolveHitKeys,
  withSessionTranscriptWriteLock,
  type SessionTranscriptReadParams,
  createSessionCatalogGitHubLinker,
  createSessionCatalogSourceActorProjector,
  readSessionTranscriptCatalogPage as readCatalogPage,
  readSessionTranscriptCatalogTitleAsync as readCatalogTitle,
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

  async function createScope(
    sessionId = "session",
    entry: Parameters<typeof upsertSessionEntryCore>[1] = { sessionId, updatedAt: 10 },
  ) {
    const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
    await upsertSessionEntryCore(scope, entry);
    return scope;
  }
  const append = (scope: SessionTranscriptReadParams, role: string, content: string) =>
    appendByIdentity({ ...scope, message: { role, content } });

  it("keeps separately keyed delivery mirrors out of authored assistant text", async () => {
    const scope = await createScope();
    for (const idempotencyKey of ["delivery-1", "delivery-2"]) {
      await expect(
        appendMirror({
          ...scope,
          idempotencyKey,
          deliveryMirror: { kind: "channel-final", sourceMessageId: idempotencyKey },
          text: "visible assistant reply",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    }
    await expect(readLatestText(scope)).resolves.toBeUndefined();
    expect(await readEntries(scope)).toHaveLength(2);
  });

  it("does not append an assistant mirror after cancellation", async () => {
    const scope = await createScope();
    const cancellation = new Error("cancelled by user");
    const signal = AbortSignal.abort(cancellation);
    const write = appendMirror({ ...scope, signal, text: "must not be persisted" });
    await expect(write).rejects.toBe(cancellation);
    await expect(readEvents(scope)).resolves.toEqual([]);
  });

  it.each(["assistant mirror", "yield context"])(
    "rejects %s after its admitted writer is superseded",
    async (operation) => {
      const scope = await createScope("session", {
        activeWriterRunId: "replacement-run",
        lifecycleRevision: "revision-a",
        sessionId: "session",
        updatedAt: 10,
      });
      const denied = "must not be persisted";
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
          () =>
            operation === "yield context"
              ? appendSessionYieldContext({ ...scope, message: denied, assertCurrent: () => {} })
              : appendMirror({ ...scope, idempotencyKey: "superseded:fallback", text: denied }),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      await expect(readEvents(scope)).resolves.toEqual([]);
    },
  );

  it("rechecks yield settlement authority after waiting for the transcript writer", async () => {
    const scope = await createScope();
    const authority = new AbortController();
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
        assertCurrent: () => authority.signal.throwIfAborted(),
      });
      const rejected = expect(write).rejects.toBe(stopped);
      authority.abort(stopped);
      releaseWriter.resolve();
      await heldWriter;
      await rejected;
    } finally {
      releaseWriter.resolve();
      await heldWriter;
    }
    await expect(readEvents(scope)).resolves.toEqual([]);
  });

  it("dedupes unkeyed mirrors only on the visible branch and rejects rebound sessions", async () => {
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
    const request = { ...scope, text: "inactive mirror reply" };
    const result = await appendMirror(request);
    expect(result).toMatchObject({ ok: true, messageId: expect.any(String) });
    assert(result.ok);
    expect(result.messageId).not.toBe(inactive.messageId);
    await expect(readEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({ id: inactive.messageId }),
    );
    await expect(appendMirror(request)).resolves.toEqual(result);
    expect(await readEntries(scope)).toMatchObject([
      { entryId: active.messageId },
      { entryId: result.messageId },
    ]);
    await createScope("replacement");
    const stale = await appendMirror({ ...scope, text: "stale reply" });
    expect(stale).toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("serializes caller-checked idempotency inside scoped locked appends", async ({ signal }) => {
    const scope = await createScope("caller-checked-lock-session");
    const steps: string[] = [];
    const firstRead = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const secondQueued = createDeferredCore();
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
        const label = ++enteredWrites === 1 ? "first" : "second";
        steps.push(`${label}:read`);
        const events = await locked.readEvents();
        const alreadyAppended = events.some(
          (event) => (event as MessageEvent).message?.idempotencyKey === "mirror-once",
        );
        if (label === "first") {
          firstRead.resolve();
          await releaseFirst.promise;
        }
        if (!alreadyAppended) {
          await locked.appendMessage({
            idempotencyLookup: "caller-checked",
            message: { ...assistant([text(label)]), idempotencyKey: "mirror-once", timestamp: 1 },
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
      firstRead.resolve();
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
    await writes;

    expect(steps).toEqual(["first:read", "first:done", "second:read", "second:done"]);
    const assistantMessages = (await readEvents(scope)).filter(
      (event) => (event as MessageEvent).message?.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatHitKey({ agentId: "main", sessionId: "deleted-session" });
    expect(resolveHitKeys({ key, store: {} })).toEqual(["agent:main:deleted-session"]);
    expect(resolveHitKeys({ includeSyntheticFallback: false, key, store: {} })).toEqual([]);
  });
});

const source = { pluginId: "session-share", sourceDomain: "source-node" };
type MessageEvent = { message?: { role?: unknown; idempotencyKey?: unknown } };
const scope = { agentId: "main", sessionKey: "agent:main:shared", sessionId: "shared-session" };
const read = (limit: number, cursor?: string) =>
  readCatalogPage({ ...scope, ...source, limit, cursor });
const user = (content: unknown, extra = {}) => ({ role: "user", content, ...extra });
const assistant = (content: unknown) => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });
const appendUser = (eventId: string, content: string, parent: { parentId?: string } = {}) =>
  appendTranscriptMessage(scope, { eventId, message: user(content), ...parent });
const items = (page: Awaited<ReturnType<typeof read>>) =>
  page.items.map((item) => [item.type, item.text]);
const title = (entry: Parameters<typeof readCatalogTitle>[0]["entry"]) =>
  readCatalogTitle({ ...scope, entry });
const profileIdentity = (id: string) => ({ type: "profile", id });
const githubProfile = (accountId: number, login: string, name: string) =>
  syncGitHubIdentity({
    identity: { accountId, login, name },
    authenticationAlias: { kind: "github-login", login },
  });
const expectProfile = (value: unknown, id: string, fields = {}) =>
  expect(value).toMatchObject({ identity: profileIdentity(id), ...fields });
const humanActor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
const remoteIdentity = (idKind: string, id: string) => ({
  type: "remote",
  pluginId: source.pluginId,
  domain: source.sourceDomain,
  idKind,
  id,
});
async function withoutHostSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeHostDataSql();
  try {
    const result = await run();
    expect(sql.queries).toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}

async function seed(messages: unknown[]) {
  setRuntimeConfigSnapshot({});
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
        user("Visible question"),
        assistant([
          text("First answer part"),
          { type: "thinking", thinking: "Reasoning" },
          { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
          { type: "output_text", text: "Second answer part" },
          { type: "tool_result", content: "Embedded tool result" },
          { type: "reasoning", text: "More reasoning" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "image", text: "Image metadata" },
          text(" \n "),
          text("NO_REPLY"),
        ]),
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [text("Tool result")],
        },
        assistant([text("Answer")]),
        { role: "tool", content: "Tool role" },
        { role: "tool_result", content: [text("Other tool role")] },
        { role: "system", content: "System instructions" },
        { role: "custom", content: [text("Unknown role")] },
        user([{ type: "tool_result", content: "User tool result" }]),
        assistant("   "),
        assistant("NO_REPLY"),
      ]);
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const before = fs.readFileSync(databasePath);
      const first = await withoutHostSql(() => read(2));
      // The shared display projection removes the standalone trailing control line.
      expect(items(first)).toEqual([
        ["agentMessage", "Answer"],
        ["agentMessage", "Second answer part"],
      ]);
      const second = await read(1, first.nextCursor);
      expect(items(second)).toEqual([["agentMessage", "First answer part"]]);
      const third = await read(2, second.nextCursor);
      expect(items(third)).toEqual([["userMessage", "Visible question"]]);
      expect(third.nextCursor).toBeUndefined();
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
    });
  });

  it("preserves text before clipping and derives the same human title as local sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        user("A useful session title"),
        assistant(`Authorization: Bearer synthetic-secret-token\n${"x".repeat(9000)}`),
      ]);
      const page = await read(1);
      expect(page.items[0]).toMatchObject({ type: "agentMessage", truncated: true });
      expect(page.items[0]?.text).toMatch(/^Authorization: Bearer synthetic-secret-token\n/);
      expect(page.items[0]?.text?.length).toBeLessThanOrEqual(6000);
      const entry = loadSessionEntryReadOnly(scope);
      assert(entry, "missing fixture entry");
      await expect(title(entry)).resolves.toBe("A useful session title");
      expect(await title({ ...entry, label: "Named", displayName: "Display" })).toBe("Named");
    });
  });

  it("reads a first title after an in-process append without caller SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([]);
      const entry = { sessionId: scope.sessionId, updatedAt: 1 };
      await expect(title(entry)).resolves.toBeUndefined();
      await appendUser("first-title", "Fresh title after append");
      await withoutHostSql(async () => {
        await expect(title(entry)).resolves.toBe("Fresh title after append");
      });
    });
  });

  it("keeps older-item cursors stable across append and rejects malformed or foreign cursors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(["one", "two", "three"].map((content) => user(content)));
      const first = await read(2);
      assert(first.nextCursor, "missing fixture cursor");
      const mixedProjectionCursor = JSON.parse(
        Buffer.from(first.nextCursor, "base64url").toString("utf8"),
      );
      // Before the text-only projection, cursor offsets also counted tools and thinking.
      const identity = [
        scope.agentId,
        scope.sessionKey,
        scope.sessionId,
        resolveSessionStorePathForScope(scope),
      ];
      mixedProjectionCursor.scope = createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("base64url");
      await expect(
        read(2, Buffer.from(JSON.stringify(mixedProjectionCursor)).toString("base64url")),
      ).rejects.toThrow("no longer matches");
      await appendUser("message-3", "four");
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
        readCatalogPage({
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
      // Join the writer's scheduled rebuild before testing read-only cursor validation.
      await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
      expect((await read(2)).items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
      for (const [eventId, parentId] of [
        ["replacement-two", "message-0"],
        ["replacement-three", "replacement-two"],
      ] as const) {
        await appendUser(eventId, eventId, { parentId });
      }
      await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
      // Equal-length branch replacements must not reuse the old ordinal as an anchor.
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
    });
  });

  it("exports portable senders and creators, linking only verified numeric GitHub identities on opt-in", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const github = githubProfile(12345, "portable-user", "Portable User");
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
        user("GitHub", { __openclaw: { senderIdentity: profileIdentity(github.id) } }),
        user("Local", { __openclaw: { senderIdentity: profileIdentity(local.id) } }),
        user("Observed", {
          __openclaw: { senderIdentity: observation, senderName: "Observed User" },
        }),
      ]);
      const page = await read(10);
      expect(page.items.map((item) => item.sender)).toEqual([
        { identity: observation, label: "Observed User" },
        { identity: remoteIdentity("profile", local.id), label: "Local User" },
        { identity: remoteIdentity("github-account", "12345"), label: "Portable User" },
      ]);
      const sender = page.items[2]?.sender;
      assert(sender, "missing GitHub sender");
      const { linkParticipant: link, resolveOwner: owner } = createSessionCatalogGitHubLinker();
      expectProfile(link(sender), github.id, { label: "Portable User" });
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
      expect(link(unmatched)).toEqual(unmatched);
      expectProfile(owner("github:PORTABLE-USER"), github.id, { type: "human", id: github.id });
      expect(owner(`profile:${local.id}`)).toMatchObject({ id: local.id, label: "Local User" });
      expect(owner("github:missing")).toBeUndefined();
      const newlyVerified = githubProfile(999, "newly-verified", "Newly Verified");
      expect(link(unmatched)).toEqual(unmatched);
      expect(owner("github:newly-verified")).toBeUndefined();
      const { linkParticipant: nextLink, resolveOwner: nextOwner } =
        createSessionCatalogGitHubLinker();
      expectProfile(nextLink(unmatched), newlyVerified.id);
      expect(nextOwner("github:newly-verified")).toMatchObject({ id: newlyVerified.id });
      const actor = humanActor(github.id);
      const projectActor = createSessionCatalogSourceActorProjector({ ...source, actors: [actor] });
      const expectedActor = { type: "human", identity: sender.identity, label: "Portable User" };
      expect(projectActor(actor)).toMatchObject(expectedActor);
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
