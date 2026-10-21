import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  deliveryContextFromSession,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.read.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  applySessionEntryReplacements as replaceEntries,
  applySessionPatchProjection,
  appendTranscriptEvent,
  appendTranscriptMessage as appendMessage,
  appendTranscriptMessageSync as appendMessageSync,
  applySessionEntryLifecycleMutation as mutateLifecycle,
  commitReplySessionInitialization as commitInitialization,
  createSessionEntryWithTranscript as createWithTranscript,
  deleteSessionEntryLifecycle as deleteLifecycle,
  findTranscriptEvent,
  listSessionTranscriptInstances,
  loadReplySessionInitializationSnapshot as loadInitialization,
  loadSessionEntry as readEntry,
  loadSessionEntryReadOnly,
  loadTranscriptEvents as loadEvents,
  markSessionAbortTarget,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  persistSessionTranscriptTurn as persistTurn,
  readTranscriptStatsSync,
  recordInboundSessionMeta as recordInbound,
  replaceSessionEntry as replaceEntry,
  resetSessionEntryLifecycle,
  SessionInitializationAgentScopeMismatchError as ScopeMismatchError,
  resolveSessionEntryAccessTarget as resolveEntry,
  resolveSessionEntryCandidateTarget,
  resolveSessionTranscriptRuntimeTarget,
  trimSessionTranscriptForManualCompact,
  updateSessionEntry as updateEntry,
  updateResolvedSessionEntry,
  updateSessionLastRoute as updateRoute,
  upsertSessionEntryCore as upsertEntry,
} from "./session-accessor.js";
import {
  loadExactSessionEntry,
  replaceSessionEntrySync as replaceEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.test-support.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { findTranscriptEventInDatabase } from "./session-accessor.sqlite-read.js";
import { applySessionEntryCanonicalReplacements as replaceCanonicalEntries } from "./session-accessor.sqlite-replacement-projection.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEvents as replaceEvents,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { createLegacyUnsequencedTurnFixture } from "./session-accessor.transcript-turn.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import {
  createManualCompactRecords,
  transcriptMessage,
} from "./transcript-message.test-support.js";
import type { SessionEntry } from "./types.js";

const cleanupArchivedSessionTranscriptsMock = vi.hoisted(() => vi.fn(async () => {}));
const tempDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-session-accessor-",
);

vi.mock("../../gateway/session-archive.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-archive.runtime.js")>();
  return { ...actual, cleanupArchivedSessionTranscripts: cleanupArchivedSessionTranscriptsMock };
});

describe("session accessor seam", () => {
  let tempDir: string;
  let storePath: string;

  const makeMessage = (
    role: "user" | "assistant",
    content: string,
    fields: Record<string, unknown> = {},
  ) => ({ role, content, ...fields });

  const turnMessage = (...args: Parameters<typeof makeMessage>) => ({
    message: makeMessage(...args),
  });

  const makeEntry = (
    sessionId: string,
    updatedAt: number,
    fields: Partial<SessionEntry> = {},
  ): SessionEntry => ({ sessionId, updatedAt, ...fields });

  const entryScope = (sessionKey: string) => ({ sessionKey, storePath });

  const agentScope = (sessionKey: string) => ({ agentId: "main", sessionKey, storePath });

  const transcriptScope = (sessionId: string, sessionKey = "agent:main:main") => ({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  });

  function expectEntry(scope: Parameters<typeof readEntry>[0], fields: Partial<SessionEntry>) {
    expect(readEntry(scope)).toMatchObject(fields);
  }

  const expectHistory = (fields: Record<string, unknown>) =>
    expect(listSessionTranscriptInstances({ agentId: "main", storePath })).toEqual(
      containing(fields),
    );

  const containing = (...objects: Record<string, unknown>[]) =>
    expect.arrayContaining(objects.map((object) => expect.objectContaining(object)));

  function expectCleared(entry: SessionEntry | undefined, fields: (keyof SessionEntry)[]) {
    expect(fields.map((field) => entry?.[field])).toEqual(fields.map(() => undefined));
  }

  async function captureUpdates<T>(
    run: () => Promise<T>,
    onUpdate?: (update: SessionTranscriptUpdate) => void,
  ) {
    const updates: SessionTranscriptUpdate[] = [];
    const internalUpdates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      onUpdate?.(update);
      updates.push(update);
    });
    const unsubscribeInternal = onInternalSessionTranscriptUpdate((update) =>
      internalUpdates.push(update),
    );
    try {
      return { result: await run(), updates, internalUpdates };
    } finally {
      unsubscribe();
      unsubscribeInternal();
    }
  }

  function publicTarget(scope: ReturnType<typeof transcriptScope>) {
    const { agentId, sessionId, sessionKey } = scope;
    return { agentId, sessionId, sessionKey };
  }

  function invalidation(scope: ReturnType<typeof transcriptScope>) {
    const target = publicTarget(scope);
    return { target, ...target };
  }

  const replacementRow = (
    sessionKey: string,
    entry: SessionEntry,
    previousSessionKeys: string[] = [],
  ) => ({ sessionKey, entry, previousSessionKeys });

  const replacementResult = (...replacements: ReturnType<typeof replacementRow>[]) => ({
    result: undefined,
    replacements,
  });

  function replacementFrom(
    entries: Parameters<Parameters<typeof replaceCanonicalEntries>[0]["update"]>[0],
    sourceKey: string,
    patch: Partial<SessionEntry> = {},
    targetKey = sourceKey,
    previousKeys = targetKey === sourceKey ? [] : [sourceKey],
  ) {
    const entry = entries.find(({ sessionKey }) => sessionKey === sourceKey)!.entry;
    return replacementRow(targetKey, { ...entry, ...patch }, previousKeys);
  }

  const replaceCanonical = <T>(
    sessionKeys: string[],
    update: Parameters<typeof replaceCanonicalEntries<T>>[0]["update"],
    options: Pick<Parameters<typeof replaceCanonicalEntries>[0], "includeLabelOwners"> = {},
  ) => replaceCanonicalEntries({ storePath, sessionKeys, update, ...options });

  const lifecycleTarget = (sessionKey: string, storeKeys = [sessionKey]) => ({
    storePath,
    target: { canonicalKey: sessionKey, storeKeys },
  });

  function openDatabase(agentId = "main") {
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
      "session database path",
    );
    return openOpenClawAgentDatabase({ agentId, path: databasePath });
  }

  const sqlRow = (
    database: ReturnType<typeof openOpenClawAgentDatabase>,
    sql: string,
    ...values: (string | number)[]
  ) => database.db.prepare(sql).get(...values);

  const seed = (
    scope: Parameters<typeof upsertEntry>[0],
    sessionId: string,
    fields: Partial<SessionEntry> = {},
    updatedAt = 10,
  ) => upsertEntry(scope, makeEntry(sessionId, updatedAt, fields));

  async function seededTranscript(name: string, fields: Partial<SessionEntry> = {}) {
    const scope = transcriptScope(`session-${name}`, `agent:main:${name}`);
    await seed(scope, scope.sessionId, fields);
    return scope;
  }

  beforeEach(() => {
    cleanupArchivedSessionTranscriptsMock.mockReset();
    tempDir = tempDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    setRuntimeConfigSnapshot({ session: { store: storePath } });
  });

  it("returns typed sync append outcomes for missing, rebound, and duplicate rows", async () => {
    const scope = transcriptScope("expected-session", "agent:main:typed-append");
    const event = { type: "custom", id: "typed-event", timestamp: 1 };
    const identity = {
      agentIdHash: redactIdentifier(scope.agentId),
      expectedSessionIdHash: redactIdentifier(scope.sessionId),
      sessionKeyHash: redactIdentifier(scope.sessionKey),
    };
    const failed = (code: string, actualSessionId?: string) => ({
      ok: false,
      error: {
        ...identity,
        code,
        ...(actualSessionId ? { actualSessionIdHash: redactIdentifier(actualSessionId) } : {}),
      },
    });
    expect(appendTranscriptEventSync(scope, event)).toEqual(failed("session-entry-missing"));

    await seed(scope, "replacement-session", {}, 1);
    const rebound = failed("session-rebound", "replacement-session");
    expect(appendTranscriptEventSync(scope, event)).toEqual(rebound);
    expect(
      appendMessageSync(scope, {
        eventId: "typed-message",
        message: { role: "user", content: "late" },
      }),
    ).toEqual(rebound);

    await seed(scope, scope.sessionId, {}, 2);
    expect(appendTranscriptEventSync(scope, event)).toEqual({ ok: true, value: true });
    expect(appendTranscriptEventSync(scope, event)).toEqual({ ok: true, value: false });
  });

  it("lists retained transcript instances across same-key session rotation", async () => {
    const scope = agentScope("agent:main:main");
    await seed(scope, "history-old", {
      pluginOwnerId: "history-owner",
      hookExternalContentSource: "webhook",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "history-old",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 10,
      },
    });
    await appendMessage(
      { ...scope, sessionId: "history-old" },
      turnMessage("assistant", "old transcript"),
    );
    await replaceEntry(scope, makeEntry("history-old", 15));
    await seed(scope, "history-new", {}, 20);
    await appendMessage(
      { ...scope, sessionId: "history-new" },
      turnMessage("assistant", "new transcript"),
    );
    const instances = listSessionTranscriptInstances({ agentId: "main", storePath });
    expect(instances.map((instance) => instance.sessionId).toSorted()).toEqual([
      "history-new",
      "history-old",
    ]);
    expect(instances).toEqual(
      containing({
        acpOwned: true,
        entry: expect.objectContaining({
          hookExternalContentSource: "webhook",
          pluginOwnerId: "history-owner",
        }),
        provenanceKnown: true,
        sessionId: "history-old",
        sessionKey: "agent:main:main",
        updatedAtMs: expect.any(Number),
      }),
    );

    const times = (rows: typeof instances) =>
      new Map(rows.map((instance) => [instance.sessionId, instance.updatedAtMs]));
    const transcriptTimes = times(instances);
    await upsertEntry(scope, { label: "renamed", updatedAt: Date.now() + 60_000 });
    expect(times(listSessionTranscriptInstances({ agentId: "main", storePath }))).toEqual(
      transcriptTimes,
    );
  });

  it("keeps migrated unknown provenance unknown while the session remains current", async () => {
    const sessionKey = "agent:main:migrated-plugin";
    const sessionId = "migrated-plugin-session";
    const scope = transcriptScope(sessionId, sessionKey);
    const fields = { pluginOwnerId: "plugin-owner" };
    const unknownHistory = {
      entry: expect.objectContaining(fields),
      provenanceKnown: false,
      sessionId,
    };
    await seed(scope, sessionId, fields);
    await appendMessage(scope, turnMessage("assistant", "plugin transcript"));
    const database = openDatabase();
    database.db
      .prepare(
        "UPDATE session_windows SET session_entry_provenance = 0, plugin_owner_id = NULL WHERE session_id = ?",
      )
      .run(sessionId);
    expectHistory(unknownHistory);
    await seed(scope, sessionId, { ...fields, label: "updated" }, 15);
    expectHistory(unknownHistory);
    await seed(scope, "replacement-session", {}, 20);
    expectHistory({ provenanceKnown: false, sessionId });
  });

  it("finds the newest matching transcript event without loading the whole transcript", async () => {
    const header = { type: "session", id: "session-find", timestamp: 1 };
    const older = { type: "message", id: "m1", message: { role: "assistant", tag: "old" } };
    const newer = { type: "message", id: "m2", message: { role: "assistant", tag: "new" } };
    await seed(entryScope("agent:main:main"), "session-find");
    await replaceEvents(transcriptScope("session-find"), [header, older, newer]);
    const database = openDatabase();
    // Count materialized rows, including eager reads before matching.
    const transcriptRows = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["transcript"],
      (sql) =>
        sql.includes('from "transcript_events"') && sql.includes('"event_json"')
          ? "transcript"
          : null,
    );
    const seen: unknown[] = [];
    const found = await Promise.resolve()
      .then(() =>
        findTranscriptEventInDatabase(database, "session-find", (event) => {
          seen.push(event);
          return (event as { type?: string }).type === "message";
        }),
      )
      .finally(() => transcriptRows.restore());
    expect(found).toEqual({ event: newer });
    expect(seen).toEqual([newer]);
    expect(transcriptRows.rowCounts.transcript).toBe(1);

    await replaceEvents(transcriptScope("session-falsy", "agent:main:falsy"), [false]);
    const falsy = await findTranscriptEvent(
      { sessionId: "session-falsy", sessionKey: "agent:main:falsy", storePath },
      { kind: "latest" },
    );
    expect(falsy).toEqual({ event: false });

    const missing = await findTranscriptEvent(
      { sessionId: "session-absent", sessionKey: "agent:main:main", storePath },
      { kind: "latest" },
    );
    expect(missing).toBeUndefined();
  });

  it("preserves activity timestamps across inbound meta and last-route updates", async () => {
    const sessionKey = "agent:main:webchat:dm:user-2";
    const anchorUpdatedAt = Date.now() - 60_000;
    await replaceEntry(entryScope(sessionKey), makeEntry("session-2", anchorUpdatedAt));
    await recordInbound({
      storePath,
      sessionKey,
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        From: "webchat:user-2",
        To: "webchat:agent",
        SessionKey: sessionKey,
        OriginatingTo: "webchat:user-2",
      },
    });
    const entry = readEntry(entryScope(sessionKey));
    expect([entry?.delivery, entry?.updatedAt]).toEqual([{ kind: "internal" }, anchorUpdatedAt]);
    const routed = await updateRoute({
      storePath,
      sessionKey,
      channel: "webchat",
      to: "webchat:user-2",
    });
    expect(routed?.delivery).toEqual({ kind: "internal" });
    const afterRoute = readEntry(entryScope(sessionKey));
    expect(deliveryContextFromSession(afterRoute)).toBeUndefined();
    expect(sessionDeliveryRoute(afterRoute)).toBeUndefined();
    expect(afterRoute?.updatedAt).toBe(anchorUpdatedAt);
  });

  it("preserves the conversation route when public metadata callers supply legacy heartbeat context", async () => {
    const provider = "heartbeat";
    const scope = entryScope("agent:main:main");
    const address = { accountId: "work", to: "C123", threadId: "thread-1" };
    const delivery: SessionEntry["delivery"] = {
      kind: "external",
      route: {
        channel: "slack",
        accountId: "work",
        target: { to: "C123" },
        thread: { id: "thread-1" },
      },
      context: { channel: "slack", ...address },
      origin: { ...address, provider: "slack", surface: "slack", nativeChannelId: "C123" },
    };
    await replaceEntry(scope, makeEntry("session-legacy-wake", 10, { delivery }));
    const meta = {
      ...scope,
      ctx: { Provider: provider, Surface: provider, OriginatingChannel: provider },
    };
    await recordInbound(meta);
    expect(readEntry(scope)?.delivery).toEqual(delivery);

    await updateRoute(meta);
    expect(readEntry(scope)?.delivery).toEqual(delivery);
  });

  it("runs the last-route ownership guard at the SQLite commit edge", async () => {
    const sessionKey = "agent:main:webchat:dm:revoked-route";

    await expect(
      updateRoute({
        storePath,
        sessionKey,
        channel: "webchat",
        to: "webchat:revoked-route",
        assertCommitAllowed: () => {
          throw new Error("route owner changed");
        },
      }),
    ).rejects.toThrow("route owner changed");

    expect(readEntry(entryScope(sessionKey))).toBeUndefined();
  });

  it("rejects alias targets and keeps canonical lifecycle mutations explicit", async () => {
    await replaceEntry(entryScope("agent:main:work"), makeEntry("canonical-session", 10));
    await replaceEntry(entryScope("agent:main:main"), makeEntry("legacy-session", 20));
    const notify = vi.fn();
    onTestFinished(onSessionIdentityMutation(notify));
    for (const storeKeys of [["agent:main:work", "agent:main:main"], ["agent:main:main"]]) {
      await expect(
        patchSessionEntryTarget(lifecycleTarget("agent:main:work", storeKeys), () => ({
          label: "patched alias",
        })),
      ).rejects.toThrow("openclaw doctor --fix");
    }
    await deleteLifecycle({ ...lifecycleTarget("agent:main:main"), archiveTranscript: false });
    await patchSessionEntryTarget(lifecycleTarget("agent:main:work"), () => ({ label: "patched" }));
    const sessionKey = "agent:main:other";
    const scope = entryScope(sessionKey);
    await replaceEntry(scope, makeEntry("created", 10));
    await patchSessionEntryCore(scope, () => ({ label: "same identity" }));
    await replaceEntry(scope, makeEntry("replaced", 20));
    const target = lifecycleTarget(sessionKey);
    await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: "reset", updatedAt: 30 }),
      ...target,
    });
    await deleteLifecycle({ archiveTranscript: false, ...target });

    expect(notify.mock.calls.map(([event]) => event.kind)).toEqual([
      "delete",
      "create",
      "replace",
      "reset",
      "delete",
    ]);
  });

  it("rejects non-canonical lineage without poisoning the store", async () => {
    const scope = agentScope("agent:main:child");
    for (const entry of [{ parentSessionKey: "Agent:Main:Parent " }, { spawnedBy: " " }]) {
      await expect(replaceEntry(scope, makeEntry("child", 10, entry))).rejects.toThrow(
        "openclaw doctor --fix",
      );
    }
    expect(readEntry(scope)).toBeUndefined();

    const child = makeEntry("child", 10, { parentSessionKey: "agent:main:parent" });
    await replaceEntry(scope, child);
    expectEntry(scope, { parentSessionKey: child.parentSessionKey, sessionId: child.sessionId });
  });

  it.each([
    { sessionKey: "global", agentId: "research", global: true },
    { sessionKey: "main", agentId: "research", global: false },
  ])(
    "keeps logical owner reads and updates isolated for $sessionKey with owner $agentId",
    async ({ sessionKey, agentId: requestedAgentId, global }) => {
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(tempDir, "{agentId}.json"),
          scope: global ? "global" : undefined,
        },
        agents: { entries: { research: {}, ops: {} } },
      };
      const canonicalKey = global ? "global" : "agent:research:main";
      for (const agentId of ["research", "ops"]) {
        await seed(
          {
            agentId,
            sessionKey: global ? "global" : `agent:${agentId}:main`,
            storePath: path.join(tempDir, `${agentId}.json`),
          },
          `${agentId}-session`,
          { label: agentId },
          1,
        );
      }
      const scope = { cfg, sessionKey, agentId: requestedAgentId };

      expect(resolveEntry(scope)).toMatchObject({
        agentId: "research",
        canonicalKey,
        entry: { sessionId: "research-session", label: "research" },
      });
      const updated = await updateResolvedSessionEntry(scope, (entry) => {
        entry.label = "updated research";
        return entry.sessionId;
      });

      expect(updated).toMatchObject({ found: true, result: "research-session", canonicalKey });
      expect(resolveEntry(scope).entry?.label).toBe("updated research");
      expect(
        readEntry({
          agentId: "ops",
          sessionKey: global ? "global" : "agent:ops:main",
          storePath: path.join(tempDir, "ops.json"),
        })?.label,
      ).toBe("ops");
    },
  );

  it.each(["ops", "retired"])(
    "preserves fixed global owner %s after canonicalizing the requested key",
    async (storeOwner) => {
      const sessionKey = "agent:research:main";
      const sharedStorePath = path.join(tempDir, "shared.sqlite");
      const storedScope = {
        agentId: storeOwner,
        defaultAgentId: storeOwner,
        storePath: sharedStorePath,
        sessionKey: "global",
      };
      await seed(storedScope, `${storeOwner}-session`, { label: "original owner label" }, 1);
      const cfg: OpenClawConfig = {
        session: { store: sharedStorePath, scope: "global" },
        agents: {
          entries: { research: {}, ops: {} },
          defaults: { sessionStore: { agentId: storeOwner } },
        },
      };
      const scope = { cfg, sessionKey, agentId: "research" };
      const expectedError = storeOwner === "retired" ? "retired" : 'belongs to "ops"';

      expect.soft(() => resolveEntry(scope)).toThrow(expectedError);
      await expect
        .soft(
          updateResolvedSessionEntry(scope, (entry) => {
            entry.label = "wrong owner mutation";
          }),
        )
        .rejects.toThrow(expectedError);
      expect(readEntry(storedScope)?.label).toBe("original owner label");
    },
  );

  it.each(["default store", "durable sessionStore fallback"])(
    "rejects a %s transcript turn when the session id rotates mid-append (#119221)",
    async (source) => {
      if (source === "default store") {
        setRuntimeConfigSnapshot({});
      }
      const stateDir = path.join(tempDir, "state-rotate-default");
      const expectedStorePath =
        source === "default store"
          ? path.join(stateDir, "agents", "main", "sessions", "sessions.json")
          : storePath;
      // Both implicit default lookup and an empty mirror must resolve persisted
      // ownership and recheck it after the append predicate.
      const scope = {
        agentId: "main",
        ...(source === "default store"
          ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
          : { storePath, sessionStore: {} }),
        sessionId: "old-default-rotate",
        sessionKey: "agent:main:default-rotate",
      };
      await replaceEntry(
        { ...scope, storePath: expectedStorePath },
        makeEntry(scope.sessionId, Date.now()),
      );
      const result = await persistTurn(scope, {
        ...(source === "default store" ? { config: {} } : {}),
        messages: [
          {
            ...turnMessage("user", "default-rotate-hello", { timestamp: Date.now() }),
            shouldAppend: () => {
              replaceEntrySync(
                { ...scope, storePath: expectedStorePath },
                makeEntry("new-default-rotate", Date.now()),
              );
              return true;
            },
          },
        ],
        touchSessionEntry: true,
        updateMode: "none",
      });

      expect(result.rejectedReason).toBe("session-rebound");
      await expect(
        loadEvents({ ...scope, storePath: expectedStorePath }),
      ).resolves.not.toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "default-rotate-hello" }),
        }),
      );
    },
  );

  it("keeps sessionStore-mirrored transcript turns on the legacy append path (#119221)", async () => {
    // Deliberately seed only the memory mirror: no persisted row can pass the guarded append.
    const sessionStore = {} as Record<string, import("./types.js").SessionEntry>;
    const scope = {
      agentId: "main",
      sessionId: "mirror-only-session",
      sessionKey: "agent:main:mirror-only",
      storePath,
      sessionStore,
    };
    sessionStore[scope.sessionKey] = { sessionId: scope.sessionId, updatedAt: Date.now() };
    const result = await persistTurn(scope, {
      messages: [turnMessage("user", "mirror-only-hello", { timestamp: Date.now() })],
      touchSessionEntry: true,
      updateMode: "none",
    });

    expect(result.rejectedReason).toBeUndefined();
    expect(result.appendedCount).toBe(1);
  });

  it("does not create database state for rejected memory-only transcript turns", async () => {
    for (const source of ["sessionStore", "sessionEntry"] as const) {
      const stateDir = path.join(tempDir, `rejected-memory-only-${source}`);
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const agentId = "main";
      const sessionKey = `agent:main:rejected-memory-only-${source}`;
      const sessionId = `rejected-memory-only-${source}`;
      const memoryStorePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
      const sessionEntry: SessionEntry = { sessionId, updatedAt: Date.now() };
      const memorySource =
        source === "sessionStore"
          ? { sessionStore: { [sessionKey]: sessionEntry } }
          : { sessionEntry };
      expect(
        loadSessionEntryReadOnly({ agentId, env, sessionKey, storePath: memoryStorePath }),
      ).toBeUndefined();
      expect(fs.existsSync(databasePath)).toBe(false);

      const result = await persistTurn(
        { agentId, env, sessionId, sessionKey, storePath: memoryStorePath, ...memorySource },
        {
          messages: [{ ...turnMessage("user", "rejected-memory-only"), shouldAppend: () => false }],
          touchSessionEntry: true,
          updateMode: "none",
        },
      );

      expect(result).toMatchObject({ appendedCount: 0, messages: [] });
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    }
  });

  it("keeps the session entry unchanged when entry preparation is rejected", async () => {
    const scope = agentScope("agent:main:main");
    await seed(scope, "pending-session", { initializationPending: true });
    const before = readEntry(scope);
    const rejected = await createWithTranscript(scope, () => ({
      ok: false,
      error: "still initializing",
    }));

    expect(rejected).toEqual({ ok: false, error: "still initializing", phase: "entry" });
    expect(readEntry({ ...scope, readConsistency: "latest" })).toEqual(before);
  });

  const pendingFinalDelivery: SessionEntry["pendingFinalDelivery"] = {
    kind: "replayable",
    text: "durable reply",
    createdAt: 11,
    context: { channel: "discord", to: "channel-1" },
    intentId: "intent-1",
  };

  it.each<{
    name: string;
    initial: Partial<SessionEntry>;
    concurrent: Partial<SessionEntry>;
    prepared: Partial<SessionEntry>;
    expected: Partial<SessionEntry>;
    keepSnapshot?: boolean;
  }>([
    {
      name: "preserves concurrent optional additions when prepared fields are undefined",
      initial: {},
      concurrent: { modelOverride: "channel-model", modelOverrideSource: "user" },
      prepared: { modelOverride: undefined, modelOverrideSource: undefined },
      expected: { modelOverride: "channel-model", modelOverrideSource: "user" },
    },
    {
      name: "does not restore pending final delivery metadata cleared after the snapshot",
      initial: { pendingFinalDelivery },
      concurrent: { pendingFinalDelivery: undefined },
      prepared: {},
      expected: {},
      keepSnapshot: true,
    },
    {
      name: "does not merge old-session delivery metadata into a rotated session",
      initial: {},
      concurrent: { pendingFinalDelivery },
      prepared: { sessionId: "new-session" },
      expected: { sessionId: "new-session" },
    },
  ])("$name", async ({ initial, concurrent, prepared, expected, keepSnapshot }) => {
    const sessionKey = "agent:main:main";
    const scope = entryScope(sessionKey);
    await upsertEntry(scope, { sessionId: "existing-session", updatedAt: 10, ...initial });
    const snapshot = await loadInitialization({ agentId: "main", ...scope });
    expect(snapshot.currentEntry).toBeDefined();
    const current = expectDefined(readEntry(scope), "existing session entry");
    const concurrentEntry = { ...current, ...concurrent };
    if (keepSnapshot) {
      delete concurrentEntry.pendingFinalDelivery;
    }
    await replaceEntry(scope, concurrentEntry);

    // Initialization guards session identity; it must retain concurrent metadata.
    const committed = await commitInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        ...(keepSnapshot ? snapshot.currentEntry : {}),
        sessionId: "existing-session",
        updatedAt: 30,
        ...prepared,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    const expectedEntry = { sessionId: "existing-session", updatedAt: 30, ...expected };
    expect(committed.sessionEntry).toMatchObject(expectedEntry);
    expectEntry(scope, expectedEntry);
    expect(committed.sessionEntry.pendingFinalDelivery).toBeUndefined();
    expect(readEntry(scope)?.pendingFinalDelivery).toBeUndefined();
  });

  it("rejects a reply initialization key scoped to another explicit agent", async () => {
    const pending = loadInitialization(agentScope("agent:ops:main"));
    await expect(pending).rejects.toBeInstanceOf(ScopeMismatchError);
    await expect(pending).rejects.toMatchObject({
      code: "SESSION_INITIALIZATION_AGENT_SCOPE_MISMATCH",
      agentId: "main",
      sessionKeyAgentId: "ops",
    });
  });

  it("normalizes alias inputs before writes and rejects invalid owners", async () => {
    for (const sessionKey of ["main", "agent:ops:main ", "agent:OPS:upper"]) {
      await expect(
        seed({ agentId: "ops", sessionKey, storePath }, "legacy-ops-session"),
      ).resolves.toMatchObject({ sessionId: "legacy-ops-session" });
    }
    await expect(
      seed({ agentId: "ops", sessionKey: "", storePath }, "empty-session"),
    ).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
    await expect(
      seed(
        { agentId: "ops", sessionKey: "agent:main:wrong-owner", storePath },
        "wrong-owner-session",
      ),
    ).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
    const insertRawEntry = async (sessionKey: string, sessionId: string, updatedAt: number) => {
      await closeOpenClawAgentDatabasesAsync();
      const database = openDatabase("ops");
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt }), updatedAt);
      markCanonicalSessionValidationPending(database, [sessionKey]);
      closeOpenClawAgentDatabasesForTest();
    };
    for (const [storedKey, canonicalKey] of [
      ["agent:ops:padded ", "agent:ops:padded"],
      [" agent:ops:leading", "agent:ops:leading"],
      ["agent:ops:nbsp\u00a0", "agent:ops:nbsp"],
    ] as const) {
      const sessionId = `${canonicalKey}-session`;
      await insertRawEntry(storedKey, sessionId, 5);
      await expect(
        seed({ agentId: "ops", sessionKey: canonicalKey, storePath }, "new-session"),
      ).rejects.toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
      closeOpenClawAgentDatabasesForTest();
      const canonicalSessionId = `${canonicalKey}-canonical-session`;
      await insertRawEntry(canonicalKey, canonicalSessionId, 6);
      expect(() => readEntry({ agentId: "ops", sessionKey: canonicalKey, storePath })).toThrow(
        "openclaw doctor --fix",
      );
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("rejects reply session initialization when the entry is deleted during prepare", async () => {
    const sessionKey = "agent:main:main";
    await seed(entryScope(sessionKey), "first-session");
    const snapshot = await loadInitialization(agentScope(sessionKey));
    const committed = await commitInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      prepareSessionEntry: async ({ sessionEntry }) => {
        await mutateLifecycle({ removals: [{ sessionKey }], storePath });
        return sessionEntry;
      },
      sessionEntry: { sessionId: "stale-session", updatedAt: 30 },
      sessionKey,
      storePath,
    });

    expect(committed).toMatchObject({ ok: false, reason: "stale-snapshot" });
    expect(readEntry(entryScope(sessionKey))).toBeUndefined();
  });

  it("keeps a pending reset through bookkeeping until an explicit consumer resolves it", async () => {
    const scope = entryScope("agent:main:pending-reset");
    await replaceEntry(
      scope,
      makeEntry("pending-reset-session", 0, { lifecycleRevision: "pending-reset-revision" }),
    );
    await updateEntry(scope, () => ({ model: "gpt-5.5", updatedAt: Date.now() }));
    expectEntry(scope, { model: "gpt-5.5", updatedAt: 0 });
    await markSessionAbortTarget({ scope });
    expectEntry(scope, { abortedLastRun: true, updatedAt: 0 });
    await updateEntry(scope, () => ({ updatedAt: Date.now() }), { consumePendingReset: true });
    expect(readEntry(scope)?.updatedAt).toBeGreaterThan(0);
  });

  it("rejects a patch when its commit-edge ownership guard retires", async () => {
    const scope = entryScope("agent:main:main");
    await seed(scope, "session-1");

    await expect(
      patchSessionEntryCore(scope, () => ({ model: "gpt-5.5" }), {
        assertCommitAllowed: () => {
          throw new Error("owner retired");
        },
      }),
    ).rejects.toThrow("owner retired");

    expect(readEntry(scope)?.model).toBeUndefined();
  });

  it("applies explicit replacements without exposing mutable store rows", async () => {
    const mainKey = "agent:main:main";
    const otherKey = "agent:main:other";
    await mutateLifecycle({
      storePath,
      upserts: (
        [
          ["main", "session-1", "interrupted", 10],
          ["other", "session-2", "interrupted", 20],
        ] as const
      ).map(([suffix, sessionId, status, updatedAt]) => ({
        sessionKey: `agent:main:${suffix}`,
        entry: { sessionId, status, updatedAt },
      })),
      skipMaintenance: true,
    });
    recordSessionParticipant(entryScope(mainKey), {
      identity: { type: "profile", id: "replacement-reader" },
      promptedAt: 10,
    });
    const database = openDatabase();
    const preparationReads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["entries", "participants"],
      (sql) => {
        if (/from\s+"session_nodes"/i.test(sql)) {
          return "entries";
        }
        return /from\s+"session_participants"/i.test(sql) ? "participants" : null;
      },
    );

    const result = await replaceEntries({
      storePath,
      update: (entries) => {
        // The detached snapshot and participant facts now come from the read worker.
        expect(preparationReads.counts.entries).toBe(0);
        expect(preparationReads.counts.participants).toBe(0);
        expect(entries.map(({ sessionKey }) => sessionKey)).toEqual([mainKey, otherKey]);
        const main = entries.find((entry) => entry.sessionKey === mainKey);
        const other = entries.find((entry) => entry.sessionKey === otherKey);
        if (other) {
          other.entry.status = "failed";
        }
        if (!main) {
          return { result: { replaced: false } };
        }
        expect(main.entry.participants).toEqual([
          { identity: { type: "profile", id: "replacement-reader" } },
        ]);
        main.entry.abortedLastRun = true;
        main.entry.updatedAt = 30;
        const replacement = replacementRow(main.sessionKey, main.entry, [otherKey]);
        return { result: { replaced: true }, replacements: [replacement] };
      },
    }).finally(() => preparationReads.restore());

    expect(result).toEqual({ replaced: true });
    expectEntry(entryScope(mainKey), {
      abortedLastRun: true,
      sessionId: "session-1",
      updatedAt: 30,
    });
    expectEntry(entryScope(otherKey), {
      sessionId: "session-2",
      status: "interrupted",
      updatedAt: 20,
    });
    const selectedKeys = await replaceEntries({
      sessionKeys: [mainKey],
      storePath,
      update: (entries) => ({ result: entries.map((entry) => entry.sessionKey) }),
    });
    expect(selectedKeys).toEqual([mainKey]);

    const other = readEntry(entryScope(otherKey));
    expect(other).toBeDefined();
    await expect(
      replaceEntries({
        sessionKeys: [mainKey],
        storePath,
        update: () => ({
          replacements: [{ sessionKey: otherKey, entry: other! }],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("outside the selected key set");

    const runtimeAliasMarker = replacementRow("agent:main:missing", {
      sessionId: "missing",
      status: undefined,
      updatedAt: 30,
    });
    const missingSelectionResult = await replaceEntries({
      sessionKeys: ["agent:main:missing"],
      storePath,
      update: () => ({ replacements: [runtimeAliasMarker], result: "missing-row-no-op" }),
    });
    expect(missingSelectionResult).toBe("missing-row-no-op");
    expect(readEntry(entryScope("agent:main:missing"))).toBeUndefined();
  });

  it("projects session patches with label ownership and current request authority", async () => {
    const keys = ["a", "b"].map((suffix) => `agent:main:project-${suffix}`);
    for (const [index, sessionKey] of keys.entries()) {
      await seed(entryScope(sessionKey), `project-${index}`, {}, index + 1);
    }
    const project = (index: number, label: string, assertCurrent?: () => void) =>
      applySessionPatchProjection<{ ok: false; error: string }>({
        storePath,
        assertCurrent,
        resolveTarget: () => ({ primaryKey: keys[index]! }),
        project: ({ existingEntry, isLabelInUse }) => {
          if (isLabelInUse(label)) {
            return { ok: false, error: `duplicate:${label}` };
          }
          return { ok: true, entry: { ...existingEntry!, label } };
        },
      });

    await expect(project(0, "Shared")).resolves.toMatchObject({
      ok: true,
      entry: { label: "Shared" },
    });
    await expect(project(1, "Shared")).resolves.toEqual({ ok: false, error: "duplicate:Shared" });
    await expect(
      project(1, "Blocked", () => {
        throw new Error("authorization changed");
      }),
    ).rejects.toThrow("authorization changed");
    expect(readEntry(entryScope(keys[0]!))?.label).toBe("Shared");
    expect(readEntry(entryScope(keys[1]!))?.label).toBeUndefined();
  });

  it("inserts and canonically rekeys through the bulk replacement owner", async () => {
    const insertedKey = "agent:main:replacement-insert";
    await replaceCanonical([insertedKey], () =>
      replacementResult(replacementRow(insertedKey, { sessionId: "inserted", updatedAt: 1 })),
    );
    expectEntry(entryScope(insertedKey), { sessionId: "inserted" });
    const canonicalKey = "agent:main:replacement-canonical";
    const previousKey = "agent:main:replacement-previous";
    await seed(entryScope(canonicalKey), "canonical-older");
    await seed(entryScope(previousKey), "rekeyed", {}, 20);
    for (const [sessionKey, count] of [
      [canonicalKey, 2],
      [previousKey, 3],
    ] as const) {
      for (let promptedAt = 0; promptedAt < count; promptedAt += 1) {
        recordSessionParticipant(entryScope(sessionKey), {
          identity: { type: "profile", id: "profile-shared" },
          promptedAt,
        });
      }
    }
    const database = openDatabase();
    const contributionCount = () =>
      sqlRow(
        database,
        "SELECT contribution_count FROM session_participants WHERE actor_id = ?",
        "profile-shared",
      );
    database.db
      .prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      )
      .run(previousKey, "member-1", "test", 1);
    const identityListener = vi.fn();
    onTestFinished(onSessionIdentityMutation(identityListener));
    await replaceCanonical([canonicalKey, previousKey], (entries) =>
      replacementResult(
        replacementFrom(entries, previousKey, { label: "Moved" }, canonicalKey, [previousKey]),
      ),
    );
    expect(readEntry(entryScope(previousKey))).toBeUndefined();
    expectEntry(entryScope(canonicalKey), { label: "Moved", sessionId: "rekeyed" });
    expect(
      sqlRow(database, "SELECT session_key FROM session_windows WHERE session_id = ?", "rekeyed"),
    ).toEqual({ session_key: canonicalKey });
    expect(
      sqlRow(
        database,
        "SELECT session_key, identity_id FROM session_members WHERE identity_id = ?",
        "member-1",
      ),
    ).toEqual({ session_key: canonicalKey, identity_id: "member-1" });
    expect(contributionCount()).toEqual({ contribution_count: 5 });
    expect(identityListener.mock.calls.map(([event]) => event.kind)).toEqual(["move", "replace"]);
    await expect(
      replaceCanonical([canonicalKey, previousKey], (entries) =>
        replacementResult(replacementFrom(entries, canonicalKey, {}, canonicalKey, [previousKey])),
      ),
    ).rejects.toThrow("cannot replace missing alias");
    expect(contributionCount()).toEqual({ contribution_count: 5 });
  });

  it("rejects internal canonical targets and alias sources without changing rows or events", async () => {
    const visibleKey = "agent:main:replacement-visible";
    const internalKey = "agent:main:internal-session-effects:replacement-guard";
    await seed(entryScope(visibleKey), "replacement-visible", { label: "Visible" });
    await seed(entryScope(internalKey), "replacement-internal", { label: "Internal" }, 20);
    const snapshot = () =>
      [visibleKey, internalKey].map((sessionKey) => loadExactSessionEntry(entryScope(sessionKey)));
    const before = snapshot();
    const identityListener = vi.fn();
    onTestFinished(onSessionIdentityMutation(identityListener));
    for (const replacement of [
      replacementRow(internalKey, makeEntry("fabricated-target", 30)),
      replacementRow(visibleKey, makeEntry("fabricated-alias", 30), [internalKey]),
    ]) {
      await expect(
        replaceCanonical([visibleKey, internalKey], () => replacementResult(replacement)),
      ).rejects.toThrow("cannot target internal effects rows");
      expect(snapshot()).toEqual(before);
    }
    expect(identityListener).not.toHaveBeenCalled();
  });

  it("rolls back mixed exact replacements and canonical rekeys as one transaction", async () => {
    const exactKey = "agent:main:replacement-rollback-exact";
    const canonicalKey = "agent:main:replacement-rollback-canonical";
    const previousKey = "agent:main:replacement-rollback-previous";
    await seed(entryScope(exactKey), "rollback-exact", { label: "Exact original" });
    await seed(entryScope(canonicalKey), "rollback-canonical", { label: "Canonical original" }, 20);
    await seed(entryScope(previousKey), "rollback-previous", { label: "Previous original" }, 30);
    const before = new Map(
      [exactKey, canonicalKey, previousKey].map((sessionKey) => [
        sessionKey,
        structuredClone(readEntry(entryScope(sessionKey))),
      ]),
    );
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);
    let refusedCommits = 0;
    const admissionSpy = probe.admission(workerAdmission, (request, grant, callback) => {
      const publication = isRecord(request.facts) ? request.facts.publication : undefined;
      if (
        request.stage === "commit" &&
        isRecord(publication) &&
        publication.kind === "session-entry-replacements"
      ) {
        expect(publication.changedKeys).toHaveLength(3);
        expect(publication.changedKeys).toEqual(
          expect.arrayContaining([exactKey, canonicalKey, previousKey]),
        );
        refusedCommits++;
        throw new Error("injected mixed replacement failure");
      }
      callback(request, grant);
    });

    try {
      await expect(
        replaceCanonical([exactKey, canonicalKey, previousKey], (entries) =>
          replacementResult(
            replacementFrom(entries, exactKey, { label: "Exact updated" }),
            replacementFrom(entries, previousKey, { label: "Canonical updated" }, canonicalKey, [
              previousKey,
            ]),
          ),
        ),
      ).rejects.toThrow("injected mixed replacement failure");
    } finally {
      admissionSpy.mockRestore();
      unsubscribe();
    }

    for (const sessionKey of [exactKey, canonicalKey, previousKey]) {
      expect(readEntry(entryScope(sessionKey))).toEqual(before.get(sessionKey));
    }
    expect(refusedCommits).toBe(1);
    expect(identityListener).not.toHaveBeenCalled();
  });

  it.each(["new claim", "released and reclaimed"] as const)(
    "rejects a label %s during detached planning",
    async (change) => {
      const reclaimed = change === "released and reclaimed";
      const target = entryScope("agent:main:label-target");
      const competing = entryScope("agent:main:label-competitor");
      await seed(target, "label-target", {}, 1);
      await seed(competing, "label-competitor", reclaimed ? { label: "Claimed" } : {}, 1);
      if (reclaimed) {
        expect(readEntry(competing)?.label).toBe("Claimed");
      }
      const externalWriter = reclaimed
        ? new DatabaseSync(
            expectDefined(
              resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
              "label race database path",
            ),
          )
        : undefined;
      const changeLabel = (label: string, updatedAt: number) => {
        if (externalWriter) {
          externalWriter
            .prepare(
              "UPDATE session_nodes SET label = ?, updated_at = ?, entry_json = json_set(entry_json, '$.label', ?, '$.updatedAt', ?) WHERE session_key = ?",
            )
            .run(label, updatedAt, label, updatedAt, competing.sessionKey);
        } else {
          replaceEntrySync(competing, makeEntry("label-competitor", updatedAt, { label }));
        }
      };
      try {
        await expect(
          replaceCanonical(
            [target.sessionKey],
            async (entries) => {
              if (reclaimed) {
                expect(
                  entries.find(({ sessionKey }) => sessionKey === competing.sessionKey)?.entry,
                ).toMatchObject({ label: "Claimed" });
                changeLabel("Released", 2);
              } else {
                expect(entries.map(({ sessionKey }) => sessionKey)).toEqual([target.sessionKey]);
              }
              await Promise.resolve();
              changeLabel("Claimed", reclaimed ? 3 : 2);
              return replacementResult(
                replacementFrom(entries, target.sessionKey, { label: "Claimed" }),
              );
            },
            { includeLabelOwners: "Claimed" },
          ),
        ).rejects.toThrow(
          reclaimed ? "changed before replacement" : "label owners changed before replacement",
        );
        expect(readEntry(target)?.label).toBeUndefined();
        expect(readEntry(competing)?.label).toBe("Claimed");
      } finally {
        externalWriter?.close();
      }
    },
  );

  it.each(["replacement", "lifecycle"] as const)(
    "rejects a stale %s projection without holding a write transaction during preparation",
    async (kind) => {
      const sessionId = kind === "replacement" ? "replacement-prepare" : "lifecycle-stale";
      const scope = entryScope(`agent:main:${sessionId}`);
      await seed(scope, sessionId, { model: "base" });
      const started = createDeferred();
      const gate = createDeferred();
      const prepare = async () => {
        started.resolve();
        await gate.promise;
      };
      const pending =
        kind === "replacement"
          ? replaceEntries({
              sessionKeys: [scope.sessionKey],
              storePath,
              update: async (entries) => {
                await prepare();
                return {
                  result: undefined,
                  replacements: entries.map(({ entry, sessionKey }) => ({
                    sessionKey,
                    entry: { ...entry, model: "planned" },
                  })),
                };
              },
            })
          : mutateLifecycle({
              storePath,
              skipMaintenance: true,
              upserts: [
                {
                  sessionKey: scope.sessionKey,
                  buildEntry: async ({ currentEntry }) => {
                    await prepare();
                    return { ...currentEntry, model: "stale-projection" } as SessionEntry;
                  },
                },
              ],
            });
      await started.promise;
      let replacementError: unknown;
      try {
        replaceEntrySync(scope, makeEntry(sessionId, 20, { model: "newer" }));
      } catch (error) {
        replacementError = error;
      } finally {
        gate.resolve();
      }
      const planningError = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(replacementError).toBeUndefined();
      expect(planningError).toMatchObject({
        message: expect.stringContaining(
          kind === "replacement" ? "changed before replacement" : "changed before lifecycle upsert",
        ),
      });
      expectEntry(scope, { model: "newer", updatedAt: 20 });
    },
  );

  it("preserves participant changes made while key-selected replacements are planned", async () => {
    const scope = entryScope("agent:main:participant-replacement");
    await seed(scope, "participant-replacement", { status: undefined });
    await seed(
      entryScope("agent:main:participant-replacement-peer"),
      "participant-replacement-peer",
      { status: undefined },
    );
    recordSessionParticipant(scope, {
      identity: {
        type: "observation",
        id: "8167215807",
        pluginId: null,
        accountId: null,
        senderKind: "unknown",
      },
      promptedAt: 10,
    });

    await replaceEntries({
      sessionKeys: [scope.sessionKey, "agent:main:participant-replacement-peer"],
      storePath,
      update: async (entries) => {
        expect(entries).toHaveLength(2);
        const snapshot = expectDefined(
          entries.find(({ sessionKey }) => sessionKey === scope.sessionKey),
          "selected replacement snapshot",
        );
        const expectedParticipants = {
          participantCount: 1,
          participants: [{ identity: { id: "8167215807" } }],
        };
        expect(snapshot.entry).toMatchObject(expectedParticipants);
        await Promise.resolve();
        expect(
          recordSessionParticipant(scope, {
            identity: { type: "agent", id: "late-participant" },
            promptedAt: 20,
          }),
        ).toBe("inserted");
        // The detached snapshot stays old; participant history has its own writer.
        expect(snapshot.entry).toMatchObject(expectedParticipants);
        return {
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, abortedLastRun: true },
            sessionKey,
          })),
          result: undefined,
        };
      },
    });

    const fresh = expectDefined(readEntry(scope), "replaced session entry");
    expect(fresh).toMatchObject({ abortedLastRun: true, participantCount: 2 });
    expect(fresh.participants?.map(({ identity }) => identity.id)).toEqual([
      "8167215807",
      "late-participant",
    ]);
    const database = openDatabase();
    const stored = expectDefined(
      sqlRow(
        database,
        "SELECT entry_json FROM session_nodes WHERE session_key = ?",
        scope.sessionKey,
      ),
      "persisted replacement row",
    );
    if (typeof stored.entry_json !== "string") {
      throw new Error("Expected persisted session JSON");
    }
    const persisted: unknown = JSON.parse(stored.entry_json);
    expect(persisted).not.toHaveProperty("participants");
    expect(persisted).not.toHaveProperty("participantCount");
  });

  it("captures SQLite archived transcript cleanup failures when requested", async () => {
    const cleanupError = new Error("cleanup failed");
    cleanupArchivedSessionTranscriptsMock.mockRejectedValueOnce(cleanupError);
    const scope = { sessionId: "session-1", sessionKey: "agent:main:cleanup", storePath };
    await seed(scope, scope.sessionId);
    await appendMessage(scope, { ...turnMessage("user", "cleanup me"), cwd: tempDir });
    const result = await mutateLifecycle({
      storePath,
      removals: [
        {
          archiveRemovedTranscript: true,
          expectedSessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        },
      ],
      cleanupArchivedTranscripts: {
        rules: [{ reason: "deleted", olderThanMs: 0 }],
        nowMs: Date.now(),
      },
      captureArtifactCleanupError: true,
      skipMaintenance: true,
    });

    expect(result.removedEntries).toBe(1);
    expect(result.archivedTranscriptDirectories).toHaveLength(1);
    expect(result.artifactCleanupError).toBe(cleanupError);
    expect(cleanupArchivedSessionTranscriptsMock).toHaveBeenCalledWith(
      expect.objectContaining({ directories: result.archivedTranscriptDirectories }),
    );
  });

  it.each([
    {
      expectedEntry: {
        lifecycleRevision: "original-revision",
        sessionId: "session-1",
        updatedAt: 999,
      },
    },
    { expectedSessionId: "session-2" },
    { expectedLifecycleRevision: "replacement-revision" },
    { expectedUpdatedAt: 20 },
  ])("does not delete lifecycle entries when guard %j mismatches", async (params) => {
    const scope = { sessionId: "session-1", sessionKey: "agent:main:guarded-delete", storePath };
    await seed(scope, scope.sessionId, { lifecycleRevision: "original-revision" });
    const result = await deleteLifecycle({
      ...lifecycleTarget(scope.sessionKey),
      archiveTranscript: false,
      ...params,
    });

    expect(result.deleted).toBe(false);
    expectEntry(scope, {
      lifecycleRevision: "original-revision",
      sessionId: scope.sessionId,
      updatedAt: expect.any(Number),
    });
  });

  it("clears progress cards when lifecycle deletion retains transcript windows", async () => {
    const sessionKey = "agent:main:progress-delete";
    const scope = transcriptScope("progress-delete", sessionKey);
    await replaceEntry(scope, makeEntry(scope.sessionId, 10));
    const database = openDatabase(scope.agentId);
    writeSessionProgressCard(database.db, sessionKey, { markdown: "Working" });
    const result = await deleteLifecycle({
      ...lifecycleTarget(sessionKey),
      archiveTranscript: false,
    });

    expect(result.deleted).toBe(true);
    expect(readEntry(scope)).toBeUndefined();
    expect(
      sqlRow(database, "SELECT entry_valid FROM session_nodes WHERE session_key = ?", sessionKey),
    ).toEqual({ entry_valid: -1 });
    expect(readSessionProgressCard(database.db, sessionKey)).toBeNull();
  });

  it("trims a manual compact transcript and clears stale token metadata", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scope = transcriptScope(sessionId);
    await seed(
      scope,
      sessionId,
      {
        contextBudgetStatus: contextBudgetStatusFixture(),
        inputTokens: 10,
        outputTokens: 20,
        cacheRead: 40,
        cacheWrite: 10,
        estimatedCostUsd: 0.02,
        totalTokens: 30,
        totalTokensFresh: true,
      },
      100,
    );
    const transcriptRecords = createManualCompactRecords(sessionId, tempDir);
    await replaceEvents(scope, transcriptRecords as Parameters<typeof replaceEvents>[1]);
    const { result, updates } = await captureUpdates(() =>
      trimSessionTranscriptForManualCompact(scope, { maxLines: 3, nowMs: 500 }),
    );
    expect(result).toMatchObject({ compacted: true, kept: 3 });
    const trimmedRecords = (await loadEvents(scope)) as Array<Record<string, unknown>>;
    expect(trimmedRecords).toMatchObject([
      { type: "session", id: sessionId },
      { type: "message", id: "entry-3", parentId: null },
      { type: "message", id: "entry-4", parentId: "entry-3" },
    ]);
    const updatedEntry = readEntry(scope);
    expect(updatedEntry).toMatchObject({ sessionId, updatedAt: 500 });
    expectCleared(updatedEntry, [
      "contextBudgetStatus",
      "inputTokens",
      "outputTokens",
      "cacheRead",
      "cacheWrite",
      "estimatedCostUsd",
      "totalTokens",
      "totalTokensFresh",
    ]);
    expect(updates).toEqual([]);
  });

  it("repairs a retained compaction boundary when its first kept entry was trimmed", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = transcriptScope(sessionId);
    const messageRecord = (id: string, parentId: string | null, content: string) => ({
      ...turnMessage("user", content),
      type: "message",
      id,
      parentId,
    });
    const records = [
      { type: "session", id: sessionId },
      messageRecord("old-boundary", null, "old"),
      messageRecord("kept-before-compaction", "old-boundary", "kept before"),
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "kept-before-compaction",
        summary: "summary",
        firstKeptEntryId: "old-boundary",
      },
      {
        type: "compaction",
        id: "compaction-2",
        parentId: "compaction-1",
        summary: "hardened summary",
        firstKeptEntryId: "compaction-2",
      },
      messageRecord("kept-after-compaction", "compaction-2", "kept after"),
    ];
    await seed(scope, sessionId, { sessionFile }, 1);
    await replaceEvents(scope, records as Parameters<typeof replaceEvents>[1]);

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 5 }),
    ).resolves.toMatchObject({ compacted: true, kept: 5 });

    const reopened = (await loadEvents(scope)) as Array<Record<string, unknown>>;
    expect(
      reopened.find((entry) => entry.type === "compaction" && entry.id === "compaction-1"),
    ).toMatchObject({ firstKeptEntryId: "kept-before-compaction" });
    expect(
      reopened.find((entry) => entry.type === "compaction" && entry.id === "compaction-2"),
    ).toMatchObject({ firstKeptEntryId: "compaction-2" });
    const serializedContext = JSON.stringify(reopened);
    expect(serializedContext).toContain("kept before");
    expect(serializedContext).toContain("kept after");
  });

  it("publishes each committed expected-session turn message with its active sequence", async () => {
    const scope = await seededTranscript("ordered-turn-guarded", {
      lifecycleRevision: "ordered-turn-revision",
    });
    await replaceEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        ...turnMessage("user", "existing message", { timestamp: 1 }),
        type: "message",
        id: "existing-message",
        parentId: null,
      },
      {
        ...turnMessage("assistant", "abandoned reply", { timestamp: 2 }),
        type: "message",
        id: "abandoned-message",
        parentId: "existing-message",
      },
      {
        type: "leaf",
        id: "select-existing-message",
        parentId: "abandoned-message",
        targetId: "existing-message",
        appendParentId: "existing-message",
      },
    ]);
    const messages = [
      turnMessage("user", "first committed message", {
        idempotencyKey: "ordered-turn-first:user",
        timestamp: 2,
      }),
      turnMessage("assistant", "second committed message", {
        idempotencyKey: "ordered-turn-second",
        timestamp: 3,
      }),
      ...Array.from({ length: 64 }, (_, index) =>
        turnMessage("user", `batch continuation ${index}`, { timestamp: index + 4 }),
      ),
    ];
    const expectedMessages = structuredClone(messages);
    const { result, updates, internalUpdates } = await captureUpdates(
      () =>
        persistTurn(scope, {
          expectedSessionId: scope.sessionId,
          runId: "run-ordered-turn",
          touchSessionEntry: true,
          messages,
          updateMode: "inline",
        }),
      () => expect(readEntry(scope)?.updatedAt).toBeGreaterThan(10),
    );
    const target = publicTarget(scope);
    expect(result.appendedCount).toBe(66);
    expect(updates).toEqual(
      expectedMessages.map(({ message }, index) =>
        Object.assign(
          invalidation(scope),
          {
            message:
              index === 1
                ? Object.assign({}, message, { __openclaw: { runId: "run-ordered-turn" } })
                : message,
            messageId: result.messages[index]?.messageId,
            messageSeq: index + 2,
          },
          index === 1 ? { runId: "run-ordered-turn" } : {},
        ),
      ),
    );
    expect(
      internalUpdates
        .filter((update) => update.message !== undefined)
        .map(({ lifecycleRevision, target: updateTarget }) => ({
          lifecycleRevision,
          target: updateTarget,
        })),
    ).toEqual(
      Array.from({ length: 66 }, () => ({
        lifecycleRevision: "ordered-turn-revision",
        target: { ...target, storePath },
      })),
    );
  });

  it("invalidates a legacy multi-message turn when active cursors cannot be proven", async () => {
    const scope = await createLegacyUnsequencedTurnFixture(storePath);
    const {
      result,
      updates: publicUpdates,
      internalUpdates,
    } = await captureUpdates(() =>
      persistTurn(scope, {
        messages: [
          {
            ...turnMessage("user", "first unsequenced message", {
              idempotencyKey: "legacy-unsequenced-first:user",
            }),
            eventId: "legacy-unsequenced-first",
          },
          {
            ...turnMessage("assistant", "second unsequenced message", {
              idempotencyKey: "legacy-unsequenced-second",
            }),
            eventId: "legacy-unsequenced-second",
          },
        ],
        updateMode: "inline",
      }),
    );
    expect(result.appendedCount).toBe(2);
    expect(publicUpdates).toEqual([invalidation(scope)]);
    expect(internalUpdates).toEqual([
      {
        ...publicTarget(scope),
        target: { ...publicTarget(scope), storePath },
        lifecycleRevision: "legacy-unsequenced-revision",
      },
    ]);
    await expect(loadEvents(scope)).resolves.toEqual(
      containing({ id: "legacy-unsequenced-first" }, { id: "legacy-unsequenced-second" }),
    );
  });

  it("never publishes rows abandoned inside one expected-session turn", async () => {
    const scope = await seededTranscript("diverging-turn-guarded", {
      lifecycleRevision: "diverging-turn-revision",
    });
    const expectedSession = { expectedSessionId: scope.sessionId };
    await persistTurn(scope, {
      ...expectedSession,
      messages: [
        transcriptMessage("diverging-turn-root", null, makeMessage("user", "common branch root")),
      ],
      updateMode: "none",
    });
    const { result, updates } = await captureUpdates(() =>
      persistTurn(scope, {
        ...expectedSession,
        messages: [
          transcriptMessage(
            "diverging-turn-abandoned",
            "diverging-turn-root",
            makeMessage("assistant", "abandoned branch", {
              idempotencyKey: "diverging-turn-abandoned",
            }),
          ),
          transcriptMessage(
            "diverging-turn-active",
            "diverging-turn-root",
            makeMessage("assistant", "final active branch", {
              idempotencyKey: "diverging-turn-active",
            }),
          ),
        ],
        updateMode: "inline",
      }),
    );

    expect(result.appendedCount).toBe(2);
    expect(updates).toEqual([invalidation(scope)]);
    await expect(loadEvents(scope)).resolves.toEqual(
      containing({ id: "diverging-turn-abandoned" }, { id: "diverging-turn-active" }),
    );
  });

  it("does not republish replayed expected-session turn messages", async () => {
    const scope = await seededTranscript("replayed-turn-guarded");
    const existing = makeMessage("user", "persisted once", {
      idempotencyKey: "replayed-turn-existing:user",
      timestamp: 1,
    });
    const expectedSession = { expectedSessionId: scope.sessionId };
    await persistTurn(scope, {
      ...expectedSession,
      messages: [{ idempotencyLookup: "scan", message: existing }],
      updateMode: "none",
    });
    const { result, updates } = await captureUpdates(() =>
      persistTurn(scope, {
        ...expectedSession,
        messages: [
          { idempotencyLookup: "scan", message: existing },
          turnMessage("assistant", "new committed reply", {
            idempotencyKey: "replayed-turn-new",
            timestamp: 2,
          }),
        ],
        updateMode: "inline",
      }),
    );

    expect(result.appendedCount).toBe(1);
    expect(result.messages.map((message) => message.appended)).toEqual([false, true]);
    expect(updates).toEqual([
      expect.objectContaining({
        message: {
          role: "assistant",
          content: "new committed reply",
          idempotencyKey: "replayed-turn-new",
          timestamp: 2,
        },
        messageId: result.messages[1]?.messageId,
        messageSeq: 2,
      }),
    ]);
  });

  it("accepts idempotent transcript replays with exact secret-shaped text", async () => {
    const scope = await seededTranscript("redacted-replay");
    const message = makeMessage("user", "same secret sk-abcdef1234567890xyz", {
      idempotencyKey: "redacted-replay:user",
      timestamp: 1,
    });
    const first = await appendMessage(scope, { idempotencyLookup: "scan", message });
    const replay = await appendMessage(scope, { idempotencyLookup: "scan", message });

    expect(first?.appended).toBe(true);
    expect(first?.message).toEqual(message);
    expect(replay).toMatchObject({ appended: false, messageId: first?.messageId });
  });

  it("rechecks a turn predicate after a direct transcript commit", async () => {
    const scope = await seededTranscript("commit-predicate");
    const admissionEntered = createDeferred();
    const admissionReleased = createDeferred<boolean>();
    const turnPromise = persistTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          ...turnMessage("assistant", "committed reply", { timestamp: 200 }),
          shouldAppend: async () => {
            admissionEntered.resolve();
            return await admissionReleased.promise;
          },
          shouldAppendInTransaction: (readLatestAssistantMessage) => {
            const latest = readLatestAssistantMessage() as { content?: unknown } | undefined;
            return latest?.content !== "committed reply";
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });
    await admissionEntered.promise;
    appendMessageSync(scope, {
      ...turnMessage("assistant", "committed reply", { stopReason: "stop", timestamp: 100 }),
      idempotencyLookup: "caller-checked",
    });
    admissionReleased.resolve(true);
    await turnPromise;
    const assistantMessages = (await loadEvents(scope)).flatMap((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant" ? [message] : [];
    });
    expect(assistantMessages).toHaveLength(1);
  });

  it("commits admission metadata only for an inserted turn or exact retryable claim", async () => {
    const scope = await seededTranscript("admission", { status: "done" });
    const message = makeMessage("user", "accepted once", {
      idempotencyKey: "run-1:user",
      timestamp: 100,
    });
    const recoveryClaim = {
      restartRecoveryDeliveryRequestFingerprint: "fingerprint-1",
      restartRecoveryDeliveryRunId: "run-1",
      restartRecoveryDeliverySourceRunId: "run-1",
    };
    const admission = {
      ...recoveryClaim,
      abortedLastRun: false,
      endedAt: undefined,
      restartRecoveryDeliveryContext: undefined,
      startedAt: 100,
      status: undefined,
      updatedAt: 100,
    };
    const attempt = (
      timestamp: number,
      expectedSessionState?: ReturnType<typeof buildRestartRecoveryExpectedState>,
    ) =>
      persistTurn(scope, {
        expectedSessionId: scope.sessionId,
        expectedSessionState,
        messages: [{ idempotencyLookup: "scan", message: { ...message, timestamp } }],
        sessionLifecyclePatch: { ...admission, startedAt: timestamp, updatedAt: timestamp },
        updateMode: "none",
      });
    const inserted = await attempt(100);
    expect(inserted.appendedCount).toBe(1);
    expectEntry(scope, {
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "run-1",
      restartRecoveryDeliverySourceRunId: "run-1",
      startedAt: 100,
      updatedAt: expect.any(Number),
    });
    expectCleared(readEntry(scope), ["restartRecoveryDeliveryContext", "status", "endedAt"]);
    const retryable = await updateEntry(scope, () => ({
      ...recoveryClaim,
      abortedLastRun: false,
      endedAt: 200,
      restartRecoveryDeliveryContext: undefined,
      status: "failed",
      updatedAt: 200,
    }));
    if (!retryable) {
      throw new Error("expected retryable admission");
    }
    const deduplicated = await attempt(300, buildRestartRecoveryExpectedState(retryable));
    expect(deduplicated.appendedCount).toBe(0);
    expect(deduplicated.messages).toHaveLength(1);
    expectEntry(scope, {
      ...recoveryClaim,
      abortedLastRun: false,
      startedAt: 300,
      updatedAt: expect.any(Number),
    });
    expectCleared(readEntry(scope), ["status", "endedAt"]);
    await updateEntry(scope, () => ({
      endedAt: 350,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: undefined,
      restartRecoveryDeliveryRunId: undefined,
      restartRecoveryDeliverySourceRunId: undefined,
      status: "done",
      updatedAt: 350,
    }));
    const historicalMatch = await attempt(400);
    expect(historicalMatch.appendedCount).toBe(0);
    expect(historicalMatch.messages).toHaveLength(1);
    expectEntry(scope, { endedAt: 350, status: "done", updatedAt: expect.any(Number) });
    expectCleared(readEntry(scope), [
      "restartRecoveryDeliveryRequestFingerprint",
      "restartRecoveryDeliveryRunId",
    ]);
    await expect(loadEvents(scope)).resolves.toHaveLength(2);
  });

  it.each([
    {
      name: "session rebind",
      initial: {},
      replacement: {
        sessionFile: "sqlite:main:session-replacement",
        sessionId: "session-replacement",
      },
      expected: {},
    },
    {
      name: "lifecycle ownership change",
      initial: { lifecycleRevision: "original-revision" },
      replacement: { lifecycleRevision: "replacement-revision" },
      expected: { expectedLifecycleRevision: "original-revision" },
    },
  ])(
    "rejects expected-session transcript turns after a $name",
    async ({ initial, replacement, expected }) => {
      const scope = transcriptScope("session-original", "agent:main:main");
      await upsertEntry(scope, { sessionId: scope.sessionId, updatedAt: 10, ...initial });
      await updateEntry(entryScope(scope.sessionKey), () => replacement, {
        skipMaintenance: true,
      });
      const result = await persistTurn(scope, {
        expectedSessionId: scope.sessionId,
        ...expected,
        messages: [turnMessage("assistant", "late reply", { timestamp: 100 })],
        publishWhen: "always",
        touchSessionEntry: true,
        updateMode: "file-only",
      });

      expect(result).toMatchObject({ appendedCount: 0, rejectedReason: "session-rebound" });
      await expect(loadEvents(scope)).resolves.toEqual([]);
    },
  );

  it("exposes only transcript identity to append predicates", async () => {
    const scope = await seededTranscript("predicate-context", {
      lastRunError: "private entry state",
    });
    let predicateContext: unknown;
    await persistTurn(scope, {
      messages: [
        {
          ...turnMessage("assistant", "not appended", { timestamp: 100 }),
          shouldAppend: (context) => {
            predicateContext = context;
            return false;
          },
        },
      ],
      updateMode: "file-only",
    });

    expect(predicateContext).toEqual(scope);
    expect(predicateContext).not.toHaveProperty("sessionEntry");
  });

  it.each(["lifecycle ownership", "pending final delivery"])(
    "rejects a guarded transcript turn when same-session %s changes",
    async (change) => {
      const scope = await seededTranscript("same-owner", {
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "control-ui-run",
        pendingFinalDelivery,
        status: "interrupted",
      });
      const stored = readEntry(scope);
      if (!stored) {
        throw new Error("expected guarded session");
      }
      const expectedSessionState = {
        ...buildRestartRecoveryExpectedState(stored),
        pendingFinalDelivery: stored.pendingFinalDelivery ?? null,
      };
      const predicateStarted = createDeferred();
      const predicateGate = createDeferred();
      const pendingTurn = persistTurn(scope, {
        expectedSessionId: scope.sessionId,
        expectedSessionState,
        sessionLifecyclePatch: { pendingFinalDelivery: undefined },
        messages: [
          {
            ...turnMessage("assistant", "stale recovery notice", { timestamp: 100 }),
            shouldAppend: async () => {
              predicateStarted.resolve();
              await predicateGate.promise;
              return true;
            },
          },
        ],
        touchSessionEntry: true,
        updateMode: "file-only",
      });
      await predicateStarted.promise;
      const replacement: SessionEntry =
        change === "pending final delivery"
          ? {
              ...stored,
              pendingFinalDelivery: { ...pendingFinalDelivery, intentId: "replacement-intent" },
            }
          : {
              abortedLastRun: false,
              restartRecoveryDeliveryRunId: "new-run",
              restartRecoveryDeliverySourceRunId: "new-run",
              sessionId: scope.sessionId,
              status: undefined,
              updatedAt: 20,
            };
      replaceEntrySync(scope, replacement);
      predicateGate.resolve();
      const result = await pendingTurn;

      expect(result).toMatchObject({ appendedCount: 0, rejectedReason: "session-rebound" });
      await expect(loadEvents(scope)).resolves.toEqual([]);
      expect(readEntry(scope)?.pendingFinalDelivery).toEqual(replacement.pendingFinalDelivery);
    },
  );

  it("keeps the persisted transcript owner when a caller supplies a stale session key", async () => {
    const sessionId = "session-canonical-owner";
    const canonicalScope = transcriptScope(sessionId);
    await seed(canonicalScope, sessionId);
    const target = await resolveSessionTranscriptRuntimeTarget({
      ...canonicalScope,
      sessionKey: "agent:main:telegram:default:direct:fixture-peer",
    });
    await appendTranscriptEvent(target, {
      id: "canonical-owner-event",
      timestamp: new Date(20).toISOString(),
      type: "metadata",
    });
    const database = openDatabase();
    expect(
      database.db
        .prepare("SELECT session_key, entry_valid FROM session_nodes ORDER BY session_key")
        .all(),
    ).toEqual([{ session_key: canonicalScope.sessionKey, entry_valid: 1 }]);
    expect(
      sqlRow(database, "SELECT session_key FROM session_windows WHERE session_id = ?", sessionId),
    ).toEqual({ session_key: canonicalScope.sessionKey });
    expect(target.sessionKey).toBe(canonicalScope.sessionKey);
  });

  it("drops imported legacy transcript paths and untrusted owners from canonical rows", async () => {
    const sessionKey = "agent:main:main";
    await importSqliteSessionRows({
      agentId: "main",
      entry: {
        owner: { actor: { type: "human", id: "spoofed" } },
        sessionFile: path.join(tempDir, "legacy-transcript.jsonl"),
        sessionId: "session-1",
        updatedAt: 10,
      },
      sessionKey,
      storePath,
    });
    const entry = loadExactSessionEntry(agentScope(sessionKey))?.entry;
    expect(entry).not.toHaveProperty("sessionFile");
    expect(entry).not.toHaveProperty("owner");
  });

  it("tracks replacement and deletion transcript mutations", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const scope = transcriptScope("session-1", "agent:main:main");
    await seed(scope, scope.sessionId);
    const events = [
      { sessionId: scope.sessionId, type: "session" },
      { timestamp: "1970-01-01T00:00:00.001Z", type: "custom", text: "🦞 café\u0000尾" },
    ];
    await replaceEvents(scope, events);
    const replaced = readTranscriptStatsSync(scope);
    expect(replaced).toMatchObject({
      eventCount: 2,
      lastMutationAtMs: expect.any(Number),
      sizeBytes: Buffer.byteLength(events.map((event) => JSON.stringify(event)).join("\n")),
    });
    expect(replaced.lastMutationAtMs).toBeGreaterThanOrEqual(1_700_000_000_000);

    await importSqliteSessionRows({
      agentId: scope.agentId,
      entry: { sessionId: scope.sessionId, updatedAt: 10 },
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
      transcriptMtimeMs: 1_600_000_000_000,
    });
    const imported = readTranscriptStatsSync(scope);
    expect(imported).toMatchObject({
      lastMutationAtMs: replaced.lastMutationAtMs,
      lastObservedMutationAtMs: replaced.lastMutationAtMs,
      sizeBytes: replaced.sizeBytes,
    });

    await replaceEvents(scope, []);
    const cleared = readTranscriptStatsSync(scope);
    dateNow.mockRestore();
    expect(cleared).toMatchObject({
      eventCount: 0,
      lastMutationAtMs: expect.any(Number),
      sizeBytes: 0,
    });
    expect(cleared.lastMutationAtMs).toBeGreaterThan(imported.lastMutationAtMs ?? 0);
  });

  it("creates entries with initialized SQLite transcripts and scoped session metadata", async () => {
    const scope = agentScope("agent:main:main");

    const created = await createWithTranscript(
      scope,
      ({ existingEntry, targetEntry, labelInUse }) => {
        expect(existingEntry).toBeUndefined();
        expect(targetEntry).toBeUndefined();
        expect(labelInUse).toBe(false);
        return { ok: true, entry: makeEntry("session-1", 10) };
      },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected session creation to succeed");
    }
    expect(created.sessionFile).toBe(scope.sessionKey);
    expect(created.entry).not.toHaveProperty("sessionFile");
    await expect(loadEvents(transcriptScope("session-1"))).resolves.toEqual([
      expect.objectContaining({ id: "session-1", type: "session" }),
    ]);
  });

  it("returns an implicit candidate fallback without persisting it", () => {
    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "main",
      candidateKeys: ["agent:main:missing"],
      cfg: { session: { store: storePath } },
      fallback: { sessionKey: "agent:main:current", entry: { sessionId: "", updatedAt: 40 } },
    });

    expect(resolved).toEqual({
      agentId: "main",
      candidateKey: "agent:main:current",
      entry: { sessionId: "", updatedAt: 40 },
      persisted: false,
      sessionKey: "agent:main:current",
    });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("reads imported transcripts before opening the SQLite transaction", async () => {
    const agentId = "main";
    const sessionId = "session-1";
    const database = openDatabase(agentId);
    let readInsideTransaction: boolean | undefined;
    await importSqliteSessionRows({
      agentId,
      entry: { sessionId, updatedAt: 10 },
      readTranscriptEvents: (append) => {
        readInsideTransaction = database.db.isTransaction;
        append({ sessionId, type: "session" });
      },
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(readInsideTransaction).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
