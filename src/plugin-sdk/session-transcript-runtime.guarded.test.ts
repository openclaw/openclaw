import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, afterAll } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { runPreparedChannelTurn } from "../channels/turn/execution.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSessionTranscriptMessageByIdentityStrict as appendStrict,
  appendSessionTranscriptMessagesByIdentity as appendGroup,
  readSessionTranscriptEvents as readEvents,
  readVisibleSessionTranscriptMessageEntries as readEntries,
  type SessionTranscriptReadParams,
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readVisibleSessionTranscriptMessageEntries,
} from "./session-transcript-runtime.js";

describe("guarded session transcript runtime SDK", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
  });
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  async function seed(route: "default" | "configured" | "incognito") {
    const agentId = route === "default" ? "main" : "secondary";
    const incognito = route === "incognito";
    if (!incognito) {
      state.applyEnv();
    }
    const config: OpenClawConfig | undefined =
      route === "configured"
        ? { session: { store: state.path("configured", "{agentId}", "sessions.json") } }
        : undefined;
    const storePath = incognito
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })
      : resolveSessionStorePathCore(config?.session?.store, { agentId, env: state.env });
    const scope: SessionTranscriptReadParams & { config?: OpenClawConfig } = {
      agentId,
      sessionId: "fresh-session",
      sessionKey: `agent:${agentId}:${incognito ? "dashboard:incognito-" : ""}fresh-session`,
      ...(incognito ? { env: state.env, storePath } : {}),
      ...(config ? { config } : {}),
    };
    const persistedScope = { ...scope, storePath };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 10,
      activeWriterRunId: "current-writer",
    };
    if (incognito) {
      await upsertSessionEntryCore(persistedScope, entry);
    } else {
      await expect(
        createSessionEntryWithTranscript(persistedScope, () => ({ ok: true, entry })),
      ).resolves.toMatchObject({ ok: true });
    }
    const superseded = <T>(run: () => Promise<T>) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...persistedScope, expectedWriterRunId: "superseded-writer" },
          withTranscriptWrite: async (write) => await write(),
        },
        run,
      );
    return { scope, persistedScope, superseded };
  }

  it("appends and replays an ordered incognito group with explicit env", async () => {
    const { scope, persistedScope } = await seed("incognito");
    const messages = [
      {
        eventId: "batch-assistant",
        idempotencyLookup: "scan" as const,
        message: { role: "assistant", content: "checking", idempotencyKey: "batch:assistant" },
        now: 1_000,
      },
      {
        eventId: "batch-result",
        idempotencyLookup: "scan" as const,
        message: { role: "toolResult", content: "done", idempotencyKey: "batch:result" },
        now: 2_000,
      },
    ];
    const appended = await appendGroup({ ...scope, messages });
    const replayed = await appendGroup({ ...scope, messages });
    expect(appended.map((result) => result.appended)).toEqual([true, true]);
    expect(replayed.map((result) => result.appended)).toEqual([false, false]);
    const events = await readEvents(persistedScope);
    expect(events).toHaveLength(3);
    expect(events.slice(1)).toMatchObject([
      { id: "batch-assistant", parentId: null },
      { id: "batch-result", parentId: "batch-assistant" },
    ]);
    const target = { agentId: "secondary", env: state.env };
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(false);
    expect(fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath(target))).toBe(false);
  });

  it("publishes a configured strict assistant with run ownership once and keeps default writes silent", async () => {
    const { scope, persistedScope } = await seed("configured");
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "persisted answer" }],
        stopReason: "stop",
        timestamp: 1_000,
        idempotencyKey: "native:attempt:assistant",
      };
      const params = { ...scope, message, runId: "current-writer", updateMode: "inline" as const };
      const written = await appendStrict(params);
      assert(written.kind === "result");
      const [entry] = await readEntries(persistedScope);
      assert(entry);
      expect(entry.message).toMatchObject({ ...message, __openclaw: { runId: "current-writer" } });
      expect(written.result.message).toEqual(entry.message);
      expect(updates).toEqual([
        expect.objectContaining({
          message: entry.message,
          messageId: entry.entryId,
          messageSeq: 1,
          runId: "current-writer",
        }),
      ]);
      await expect(appendStrict(params)).resolves.toMatchObject({
        kind: "result",
        result: { appended: false, messageId: entry.entryId },
      });
      await expect(
        appendStrict({
          ...scope,
          message: { ...message, idempotencyKey: "separate-journal:assistant" },
        }),
      ).resolves.toMatchObject({ kind: "result", result: { appended: true } });
      expect(updates).toHaveLength(1);
      expect(await readEntries(persistedScope)).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it("distinguishes strict singleton results, suppression, and rebound without a store path", async () => {
    const { scope, persistedScope, superseded } = await seed("default");
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "persisted" }],
      timestamp: 1_000,
      idempotencyKey: "strict:assistant",
    };
    await expect(appendStrict({ ...scope, message })).resolves.toMatchObject({
      kind: "result",
      result: { appended: true },
    });
    await expect(
      appendStrict({
        ...scope,
        message: { role: "user", content: "blocked" },
        prepareMessageAfterIdempotencyCheck: () => undefined,
      }),
    ).resolves.toEqual({ kind: "suppressed" });
    const events = await readEvents(persistedScope);
    expect(events).toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ type: "message", message }),
    ]);
    await expect(superseded(() => appendStrict({ ...scope, message }))).resolves.toEqual({
      kind: "rejected",
      reason: "session-rebound",
    });
    await upsertSessionEntryCore(persistedScope, {
      sessionId: "replacement-session",
      updatedAt: 20,
    });
    await expect(
      appendStrict({
        ...scope,
        message: { role: "assistant", content: "stale" },
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "session-rebound" });
    await expect(readEvents(persistedScope)).resolves.toEqual(events);
    await expect(
      readEvents({ ...persistedScope, sessionId: "replacement-session" }),
    ).resolves.toEqual([]);
  });
});

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-transcript-fence-");
describe("session transcript runtime read fence", () => {
  let scope: SessionTranscriptReadParams & { agentId: string; storePath: string };
  beforeEach(async () => {
    scope = {
      agentId: "main",
      sessionId: "fenced",
      sessionKey: "agent:main:fenced",
      storePath: path.join(tempDirs.make(), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  });
  async function seedHistory() {
    const rows = [];
    for (const [index, content] of ["prompt", "prior", "prompt", "current"].entries()) {
      const now = (index + 1) * 1_000;
      const row = await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: index % 2 ? "assistant" : "user", content, timestamp: now },
        now,
      });
      assert(row?.anchor);
      rows.push(row);
    }
    const [priorUser, priorAssistant, admitted] = rows;
    assert(priorUser && priorAssistant && admitted?.anchor);
    return {
      priorUser,
      priorAssistant,
      admitted,
      receipt: { ...admitted.anchor, logicalTurnId: "fenced-turn", role: "user" as const },
    };
  }

  it("fences full and raw reads before the exact admitted row and resumes from its cursor", async () => {
    const { priorUser, priorAssistant, admitted, receipt } = await seedHistory();
    const page = await runWithSessionTranscriptReadFence(receipt, async () => {
      const events = await readSessionTranscriptEvents(scope);
      expect(loadTranscriptEventsSync(scope)).toEqual(events);
      expect(events).toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({ id: priorUser.messageId }),
        expect.objectContaining({ id: priorAssistant.messageId }),
      ]);
      expect(
        (await readVisibleSessionTranscriptMessageEntries(scope)).map((entry) => entry.entryId),
      ).toEqual([priorUser.messageId, priorAssistant.messageId]);
      await expect(readLatestAssistantTextByIdentity(scope)).resolves.toMatchObject({
        id: priorAssistant.messageId,
        text: "prior",
      });
      return readSessionTranscriptRawDelta({ ...scope, maxBytes: 100_000, maxEvents: 100 });
    });
    assert(page.kind === "page");
    expect(page.hasMore).toBe(false);
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: page.cursor,
        maxBytes: 100_000,
        maxEvents: 100,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      events: [
        { event: { id: admitted.messageId, message: { content: "prompt" } } },
        { event: { message: { content: "current" } } },
      ],
      hasMore: false,
    });
  });

  it("restores cold history before channel preparation with its history boundary", async () => {
    const { receipt } = await seedHistory();
    const options = { agentId: scope.agentId, path: receipt.storePath };
    await waitForSessionTranscriptIndexReconcile(options);
    await replaceSessionEntry(scope, {
      ...loadSessionEntry(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
      lastActivityAt: 1,
      lastInteractionAt: 1,
    });
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", scope.sessionId),
      );
    }, options);
    await expect(
      runSessionColdStorageMaintenance({
        config: {
          agents: { entries: { main: {} } },
          session: {
            store: options.path,
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
      }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(() => loadTranscriptEventsSync(scope)).toThrow(/cold storage/);
    const ctx: FinalizedMsgContext = {
      Body: "continue",
      CommandAuthorized: false,
      AgentId: scope.agentId,
      SessionKey: scope.sessionKey,
      Timestamp: 3_000,
      SessionTranscriptContext: { historyLimit: 10 },
    };
    let dispatched = false;
    await runPreparedChannelTurn({
      channel: "slack",
      routeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      ctxPayload: ctx,
      recordInboundSession: async () => undefined,
      runDispatch: async () => {
        dispatched = true;
        expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual(["prompt", "prior"]);
        return { queuedFinal: false };
      },
    });
    expect(dispatched).toBe(true);
  });

  it("rejects a read fence when any immutable admission field changes", async () => {
    const { receipt } = await seedHistory();
    const invalidReceipts = [
      { ...receipt, storePath: `${receipt.storePath}.other` },
      { ...receipt, sessionKey: `${receipt.sessionKey}:other` },
      { ...receipt, generation: `${receipt.generation}:other` },
      { ...receipt, rawSeq: receipt.rawSeq + 1 },
      { ...receipt, effectiveParentId: "other-parent" },
      { ...receipt, activeMessagePosition: receipt.activeMessagePosition + 1 },
      { ...receipt, role: "assistant" as const },
    ];
    for (const invalid of invalidReceipts) {
      expect(() =>
        runWithSessionTranscriptReadFence(invalid as unknown as typeof receipt, () =>
          loadTranscriptEventsSync(scope),
        ),
      ).toThrow(SessionTranscriptReadFenceError);
      await expect(
        runWithSessionTranscriptReadFence(invalid as unknown as typeof receipt, () =>
          readSessionTranscriptEvents(scope),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
    }
    const events = loadTranscriptEventsSync(scope);
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(() =>
      runWithSessionTranscriptReadFence(receipt, () => loadTranscriptEventsSync(scope)),
    ).toThrow(SessionTranscriptReadFenceError);
    expect(loadTranscriptEventsSync(scope)).toEqual(events);
  });
});
