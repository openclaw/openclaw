import path from "node:path";
import { constants as sqliteConstants } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { CodeModeTranscriptAuthority } from "../../agents/code-mode-waiting-claim.js";
import type { AgentHarnessHostCapabilities } from "../../agents/harness/host-capability-types.js";
import { registerAgentHarnessTranscriptPrefixCommit } from "../../agents/harness/host-private-capabilities.js";
import type { AgentMessage as RuntimeAgentMessage } from "../../agents/runtime/index.js";
import type { AgentMessage } from "../../plugin-sdk/agent-core.js";
import { commitProviderSessionTranscriptPrefix } from "../../plugin-sdk/provider-session-transcript-runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntryReadOnly, loadTranscriptEventsSync } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { commitExpectedSessionTranscriptPrefix } from "./session-accessor.sqlite-transcript-prefix.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { projectPublicSessionEntry } from "./session-entry-projection.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs: string[] = [];

describe("durable session transcript prefix", () => {
  let scope: {
    agentId: string;
    config: { session: { store: string } };
    expectedLifecycleRevision: string;
    expectedWriterRunId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
  let baseAnchor: TranscriptEntryAnchor;
  let authority: CodeModeTranscriptAuthority;
  let hostCapabilities: AgentHarnessHostCapabilities;
  let hostClosed = false;

  function resetAuthority() {
    authority?.close();
    hostClosed = false;
    hostCapabilities = {
      assertActive: () => {
        if (hostClosed) {
          throw new Error("host capability is no longer active");
        }
      },
    } as AgentHarnessHostCapabilities;
    authority = new CodeModeTranscriptAuthority({
      scope,
      lifecycleRevision: scope.expectedLifecycleRevision,
      writerRunId: scope.expectedWriterRunId,
    });
    registerAgentHarnessTranscriptPrefixCommit(hostCapabilities, async (params) =>
      authority.commitPrefix(params, (message) => message, hostCapabilities.assertActive),
    );
  }

  beforeEach(() => {
    const storePath = path.join(makeTempDir(tempDirs, "durable-prefix-"), "sessions.json");
    scope = {
      agentId: "main",
      config: { session: { store: storePath } },
      expectedLifecycleRevision: "lifecycle-a",
      expectedWriterRunId: "writer-a",
      sessionId: "session-a",
      sessionKey: "agent:main:durable-prefix",
      storePath,
    };
    replaceSessionEntrySync(scope, {
      activeWriterRunId: scope.expectedWriterRunId,
      lifecycleRevision: scope.expectedLifecycleRevision,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    resetAuthority();
    const base = appendMessage({
      eventId: "base-user",
      message: {
        role: "user",
        content: "run the tool",
        idempotencyKey: "base-user",
        timestamp: 1,
      },
    });
    if (!base?.anchor) {
      throw new Error("missing base transcript anchor");
    }
    baseAnchor = base.anchor;
  });

  afterEach(() => {
    authority.close();
    closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  function toolEntries(timestamp = 2) {
    return [
      {
        eventId: "assistant-call",
        identity: "assistant-call",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-a",
              name: "exec",
              arguments: { command: "echo ok" },
            },
          ],
          idempotencyKey: "assistant-call",
          timestamp,
        } satisfies AgentMessage,
      },
      {
        eventId: "tool-result",
        identity: "tool-result",
        message: {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "exec",
          content: [{ type: "text", text: "ok" }],
          details: { status: "completed" },
          idempotencyKey: "tool-result",
          isError: false,
          timestamp: timestamp + 1,
        } satisfies AgentMessage,
      },
    ];
  }

  function transcriptMessages() {
    return loadTranscriptEventsSync(scope).flatMap((event) =>
      event.type === "message"
        ? [{ id: event.id, message: event.message, parentId: event.parentId }]
        : [],
    );
  }

  function appendMessage(options: Parameters<typeof appendTranscriptMessageSync>[1]) {
    const outcome = appendTranscriptMessageSync(scope, options);
    if (!outcome.ok) {
      throw new Error(`transcript append refused: ${outcome.error.code}`);
    }
    return outcome.value;
  }

  function commit(entries = toolEntries(), anchor = baseAnchor) {
    return commitProviderSessionTranscriptPrefix({
      hostCapabilities,
      baseAnchor: anchor,
      entries: entries.map((entry) => ({
        ...entry,
        message: { ...entry.message, idempotencyKey: entry.identity },
      })),
    });
  }

  function claimEntry(
    eventId: string,
    waitingRunId: string,
    params: {
      expiresAt?: number;
      outcome?: "remove" | "replace";
      predecessorEntryId?: string;
    } = {},
  ) {
    const message = {
      role: "toolResult" as const,
      toolCallId: eventId,
      toolName: "exec",
      content: [{ type: "text" as const, text: eventId }],
      details:
        params.outcome === "remove"
          ? { status: "completed" }
          : { status: "waiting", runId: waitingRunId },
      idempotencyKey: eventId,
      timestamp: Date.now(),
    } satisfies AgentMessage;
    return {
      codeModeClaimIntent: {
        expiresAt: params.expiresAt ?? Date.now() + 60_000,
        lifecycleRevision: scope.expectedLifecycleRevision,
        outcome: params.outcome ?? "replace",
        predecessorEntryId: params.predecessorEntryId,
        runId: waitingRunId,
        sourceDigest: `digest-${waitingRunId}`,
        sourceToolCallId: eventId,
        sourceToolName: "exec",
        writerRunId: scope.expectedWriterRunId,
      },
      eventId,
      identity: eventId,
      message,
    };
  }

  function commitClaims(entries: ReturnType<typeof claimEntry>[], anchor = baseAnchor) {
    return commitExpectedSessionTranscriptPrefix(scope, {
      baseAnchor: anchor,
      entries,
      expectedLifecycleRevision: scope.expectedLifecycleRevision,
      expectedWriterRunId: scope.expectedWriterRunId,
    });
  }

  it("commits one prepared suffix and replays it through the same host capability", async () => {
    const committed = await commit();
    expect(committed).toMatchObject({ kind: "committed" });
    expect(committed.kind === "committed" ? committed.messages[1] : undefined).toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });

    const replayed = await commit(toolEntries(99));
    expect(replayed).toMatchObject({ kind: "replayed" });
    expect(replayed.kind === "replayed" ? replayed.messages[1] : undefined).toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(transcriptMessages()).toHaveLength(3);
  });

  it("rejects display and source drift while tolerating timestamp drift", async () => {
    await commit();
    await expect(commit(toolEntries(50))).resolves.toMatchObject({ kind: "replayed" });

    const displayChanged = toolEntries(50);
    displayChanged[1] = {
      ...displayChanged[1],
      message: { ...displayChanged[1]!.message, display: false },
    };
    await expect(commit(displayChanged)).resolves.toMatchObject({
      kind: "conflict",
      reason: "prefix-payload-or-topology-mismatch",
    });

    const payloadChanged = toolEntries(50);
    payloadChanged[1] = {
      ...payloadChanged[1],
      message: {
        ...payloadChanged[1]!.message,
        content: [{ type: "text", text: "different source" }],
      },
    };
    await expect(commit(payloadChanged)).resolves.toMatchObject({
      kind: "conflict",
      reason: "prefix-payload-or-topology-mismatch",
    });
  });

  it.each([
    ["agentId", "other-agent"],
    ["sessionId", "other-session"],
    ["sessionKey", "agent:main:other"],
    ["storePath", "/tmp/other.sqlite"],
    ["generation", "other-generation"],
    ["entryId", "other-entry"],
    ["rawSeq", 999],
    ["effectiveParentId", "other-parent"],
    ["activeMessagePosition", 999],
    ["idempotencyKey", "other-key"],
  ] as const)("rejects a base anchor %s mismatch", async (field, value) => {
    await expect(commit(toolEntries(), { ...baseAnchor, [field]: value })).resolves.toMatchObject({
      kind: "conflict",
      reason: "base-anchor-mismatch",
    });
    expect(transcriptMessages()).toHaveLength(1);
  });

  it("rejects gaps, branch drift, and replay after lifecycle or writer rebound", async () => {
    appendMessage({
      eventId: "tool-result",
      message: toolEntries()[1]!.message,
      parentId: baseAnchor.entryId,
    });
    await expect(commit()).resolves.toMatchObject({ kind: "conflict", reason: "prefix-gap" });

    const otherStore = path.join(makeTempDir(tempDirs, "durable-prefix-branch-"), "sessions.json");
    scope = { ...scope, config: { session: { store: otherStore } }, storePath: otherStore };
    replaceSessionEntrySync(scope, {
      activeWriterRunId: scope.expectedWriterRunId,
      lifecycleRevision: scope.expectedLifecycleRevision,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    resetAuthority();
    const base = appendMessage({
      eventId: "base-user",
      message: { role: "user", content: "base", idempotencyKey: "base-user", timestamp: 1 },
    });
    if (!base?.anchor) {
      throw new Error("missing branch base");
    }
    baseAnchor = base.anchor;
    appendMessage({
      eventId: "unrelated",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "other" }],
        idempotencyKey: "unrelated",
        timestamp: 2,
      },
    });
    await expect(commit()).resolves.toMatchObject({
      kind: "conflict",
      reason: "active-branch-drift",
    });

    const replayStore = path.join(makeTempDir(tempDirs, "durable-prefix-replay-"), "sessions.json");
    scope = { ...scope, config: { session: { store: replayStore } }, storePath: replayStore };
    replaceSessionEntrySync(scope, {
      activeWriterRunId: scope.expectedWriterRunId,
      lifecycleRevision: scope.expectedLifecycleRevision,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    resetAuthority();
    const replayBase = appendMessage({
      eventId: "base-user",
      message: { role: "user", content: "base", idempotencyKey: "base-user", timestamp: 1 },
    });
    if (!replayBase?.anchor) {
      throw new Error("missing replay base");
    }
    baseAnchor = replayBase.anchor;
    await expect(commit()).resolves.toMatchObject({ kind: "committed" });
    replaceSessionEntrySync(scope, {
      ...loadSessionEntryReadOnly(scope),
      activeWriterRunId: "writer-b",
    });
    await expect(commit()).rejects.toThrow("code mode transcript authority is stale");
  });

  it("returns a typed conflict when the branch drifts after preparation", async () => {
    const entries = toolEntries();
    const entered = createDeferred();
    const release = createDeferred();
    const heldWriter = runExclusiveSqliteSessionWrite(
      resolveSqliteTranscriptScope(scope),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    const outcome = commitExpectedSessionTranscriptPrefix(scope, {
      baseAnchor,
      entries,
      expectedLifecycleRevision: scope.expectedLifecycleRevision,
      expectedWriterRunId: scope.expectedWriterRunId,
    });
    appendMessage({
      eventId: "racing-writer",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "race" }],
        idempotencyKey: "racing-writer",
        timestamp: 4,
      },
    });
    release.resolve();
    await heldWriter;
    await expect(outcome).resolves.toMatchObject({
      kind: "conflict",
      reason: "transaction-drift",
    });
    expect(transcriptMessages().map((entry) => entry.id)).toEqual(["base-user", "racing-writer"]);
  });

  it.each(["authority", "host"] as const)(
    "rejects queued writes after %s closure",
    async (closed) => {
      const entered = createDeferred();
      const release = createDeferred();
      const heldWriter = runExclusiveSqliteSessionWrite(
        resolveSqliteTranscriptScope(scope),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      const outcome = commit();
      if (closed === "authority") {
        authority.close();
      } else {
        hostClosed = true;
      }
      release.resolve();
      await heldWriter;
      await expect(outcome).rejects.toThrow(
        closed === "authority" ? "authority is closed" : "host capability is no longer active",
      );
      expect(transcriptMessages().map((entry) => entry.id)).toEqual(["base-user"]);
    },
  );

  it("keeps ordinary appends claim-neutral", () => {
    const before = loadSessionEntryReadOnly(scope) as InternalSessionEntry;
    appendMessage({
      eventId: "ordinary",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ordinary" }],
        idempotencyKey: "ordinary",
      },
    });
    const after = loadSessionEntryReadOnly(scope) as InternalSessionEntry;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.codeModeWaitingClaims).toEqual(before.codeModeWaitingClaims);
  });

  it("atomically replaces and removes claims while pruning expiry and the bounded tail", async () => {
    const created = await commitClaims([claimEntry("exec-waiting", "worker-a")]);
    if (created.kind !== "committed") {
      throw new Error("claim setup failed");
    }
    let internal = loadSessionEntryReadOnly(scope) as InternalSessionEntry;
    const first = internal.codeModeWaitingClaims?.["worker-a"];
    expect(first?.anchor.entryId).toBe("exec-waiting");
    expect(projectPublicSessionEntry(internal)).not.toHaveProperty("codeModeWaitingClaims");

    const replaced = await commitClaims(
      [claimEntry("wait-again", "worker-a", { predecessorEntryId: first?.anchor.entryId })],
      created.anchors[0],
    );
    if (replaced.kind !== "committed") {
      throw new Error("claim replacement failed");
    }
    internal = loadSessionEntryReadOnly(scope) as InternalSessionEntry;
    expect(internal.codeModeWaitingClaims?.["worker-a"]?.anchor.entryId).toBe("wait-again");

    const stale = claimEntry("wait-stale", "worker-a", {
      predecessorEntryId: "wrong-entry",
    });
    await expect(commitClaims([stale], replaced.anchors[0])).rejects.toThrow(
      "waiting claim changed",
    );
    const terminal = claimEntry("wait-terminal", "worker-a", {
      outcome: "remove",
      predecessorEntryId: "wait-again",
    });
    const removed = await commitClaims([terminal], replaced.anchors[0]);
    if (removed.kind !== "committed") {
      throw new Error("claim removal failed");
    }
    expect(
      (loadSessionEntryReadOnly(scope) as InternalSessionEntry).codeModeWaitingClaims?.["worker-a"],
    ).toBeUndefined();

    const entries = [
      claimEntry("expired", "expired-worker", { expiresAt: Date.now() - 1 }),
      ...Array.from({ length: 66 }, (_, index) =>
        claimEntry(`capped-${index}`, `worker-${index}`, {
          expiresAt: Date.now() + 60_000 + index,
        }),
      ),
    ];
    await expect(commitClaims(entries, removed.anchors[0])).resolves.toMatchObject({
      kind: "committed",
    });
    const claims = (loadSessionEntryReadOnly(scope) as InternalSessionEntry).codeModeWaitingClaims;
    expect(Object.keys(claims ?? {})).toHaveLength(64);
    expect(claims?.["expired-worker"]).toBeUndefined();
    expect(claims?.["worker-0"]).toBeUndefined();
    expect(claims?.["worker-65"]?.anchor.entryId).toBe("capped-65");
  });

  it("keeps claim association on each selected append when a sibling is skipped", async () => {
    const skipped = claimEntry("skipped-result", "skipped-run");
    const selected = claimEntry("selected-result", "selected-run");
    await appendExpectedSessionTranscriptTurn(scope, {
      expectedLifecycleRevision: scope.expectedLifecycleRevision,
      expectedSessionId: scope.sessionId,
      expectedWriterRunId: scope.expectedWriterRunId,
      messages: [
        { ...skipped, shouldAppend: () => false },
        { ...selected, parentId: baseAnchor.entryId },
      ],
      sessionFile: scope.sessionKey,
    });
    const claims = (loadSessionEntryReadOnly(scope) as InternalSessionEntry).codeModeWaitingClaims;
    expect(claims?.["skipped-run"]).toBeUndefined();
    expect(claims?.["selected-run"]?.anchor.entryId).toBe("selected-result");
  });

  it("rebuilds dirty facts once across more than 4k prefix rows", async () => {
    const entries = Array.from({ length: 4_005 }, (_, index) => ({
      eventId: `assistant-${index}`,
      identity: `assistant-${index}`,
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `${index}` }],
        idempotencyKey: `assistant-${index}`,
        timestamp: index + 2,
      } satisfies AgentMessage,
    }));
    await expect(commit(entries)).resolves.toMatchObject({ kind: "committed" });

    const resolved = resolveSqliteTranscriptScope(scope);
    openOpenClawAgentDatabase(toDatabaseOptions(resolved))
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(scope.sessionId);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    let authoritativeReads = 0;
    database.db.setAuthorizer((action, table, column) => {
      if (
        action === sqliteConstants.SQLITE_READ &&
        table === "transcript_events" &&
        column === "event_json"
      ) {
        authoritativeReads += 1;
      }
      return sqliteConstants.SQLITE_OK;
    });
    const suffix = {
      eventId: "assistant-suffix",
      identity: "assistant-suffix",
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "suffix" }],
        idempotencyKey: "assistant-suffix",
        timestamp: 9_999,
      } satisfies AgentMessage,
    };
    await expect(commit([...entries, suffix])).resolves.toMatchObject({ kind: "committed" });
    database.db.setAuthorizer(null);
    expect(authoritativeReads).toBeLessThanOrEqual(5);
    expect(transcriptMessages().at(-1)?.id).toBe("assistant-suffix");
  });

  it("replays a migrated prefix when a delivery mirror precedes the header", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "New session started." }],
      idempotencyKey: "migrated-mirror",
    } satisfies RuntimeAgentMessage;
    const appended = appendMessage({
      eventId: "migrated-mirror",
      message,
    });
    if (!appended?.anchor) {
      throw new Error("missing migrated anchor");
    }
    startSessionTranscriptIndexReconcile({
      agentId: scope.agentId,
      preferredSessionId: scope.sessionId,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
    );
    database.db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
    for (const [table, column] of [
      ["transcript_events", "seq"],
      ["transcript_event_identities", "seq"],
      ["session_transcript_active_events", "event_seq"],
    ] as const) {
      for (const [from, to] of [
        [0, 99],
        [1, 0],
        [99, 1],
      ] as const) {
        database.db
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE session_id = ? AND ${column} = ?`)
          .run(to, scope.sessionId, from);
      }
    }
    database.db.exec("COMMIT;");

    await expect(
      commitProviderSessionTranscriptPrefix({
        hostCapabilities,
        entries: [
          {
            eventId: "migrated-mirror",
            identity: "migrated-mirror",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "New session started." }],
              idempotencyKey: "migrated-mirror",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ kind: "replayed" });
  });

  it("replays an exact migrated prefix with no auxiliary identity rows", async () => {
    const migratedStore = path.join(
      makeTempDir(tempDirs, "durable-prefix-import-"),
      "sessions.json",
    );
    scope = { ...scope, config: { session: { store: migratedStore } }, storePath: migratedStore };
    const source = {
      role: "user",
      content: "hello",
      idempotencyKey: "migrated-message",
    } satisfies RuntimeAgentMessage;
    const message = source;
    await importSqliteSessionRows({
      ...scope,
      entry: {
        activeWriterRunId: scope.expectedWriterRunId,
        lifecycleRevision: scope.expectedLifecycleRevision,
        sessionId: scope.sessionId,
        updatedAt: 1,
      },
      readExactTranscriptRows: (append) => {
        append({
          createdAt: 1,
          eventJson: JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
        });
        append({
          createdAt: 2,
          eventJson: JSON.stringify({
            type: "message",
            id: "migrated-message",
            parentId: null,
            message,
          }),
        });
      },
    });
    resetAuthority();
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
    );
    expect(
      (
        database.db
          .prepare("SELECT COUNT(*) AS count FROM transcript_event_identities WHERE session_id = ?")
          .get(scope.sessionId) as { count: number }
      ).count,
    ).toBe(0);

    await expect(
      commitProviderSessionTranscriptPrefix({
        hostCapabilities,
        entries: [
          {
            eventId: "migrated-message",
            identity: "migrated-message",
            message,
          },
        ],
      }),
    ).resolves.toMatchObject({ kind: "replayed" });
    expect(
      projectPublicSessionEntry(loadSessionEntryReadOnly(scope) as InternalSessionEntry),
    ).not.toHaveProperty("codeModeWaitingClaims");
  });
});
