import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  readSessionSubmittedInput,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputReceipts,
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("committed pending input release", () => {
  const fixture = useTempSessionsFixture("pending-input-consumed-release-");
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:consumed-release",
    sessionId: "consumed-session",
    storePath: fixture.storePath(),
  });
  const options = () => toDatabaseOptions(resolveSqliteScope(scope()));
  const database = () => openOpenClawAgentDatabase(options());
  const receipts: SessionPendingInputReceipt[] = [];
  const message = (id: string, content = "Synthetic accepted input") => ({
    role: "user" as const,
    content,
    timestamp: 1,
    idempotencyKey: `${id}:user`,
  });
  const stage = async (
    id: string,
    stageOptions: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(), {
        runId: id,
        message: message(id),
        assertCurrent: () => {},
        ...stageOptions,
      }),
      "Expected staged input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const prepare = async (collected: boolean) => {
    const first = await stage("first");
    const sources = [first];
    if (!collected) {
      return { receipt: first, sources };
    }
    sources.push(await stage("second"));
    const receipt = expectDefined(
      bindSessionPendingInputSources(sources, message("aggregate")),
      "Expected collected input custody",
    );
    return { receipt, sources };
  };
  const promoteSync = (receipt: SessionPendingInputReceipt) =>
    expect(
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
    ).toMatchObject({ ok: true, value: { appended: true } });
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([false, true])(
    "permits only exact committed persistence after custody closes (collected: %s)",
    async (collected) => {
      const source = await stage("closed-persistence");
      const receipt = collected
        ? bindSessionPendingInputSources([source], message("closed-aggregate"))!
        : source;
      if (collected) {
        receipts.push(receipt);
      }
      await promote(receipt);
      receipt.finish("cancelled");
      expect(() => receipt.run(() => {})).toThrow("ownership ended");
      const before = await loadTranscriptEvents(scope());
      expect(
        await withSessionPendingInputPersistence(receipt, () =>
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ),
      ).toMatchObject({ appended: false, messageId: receipt.inputId });
      expect(await loadTranscriptEvents(scope())).toEqual(before);
      await replaceTranscriptEvents(scope(), []);
      await expect(
        withSessionPendingInputPersistence(receipt, () =>
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ),
      ).rejects.toThrow("custody ended");
      expect(await loadTranscriptEvents(scope())).toEqual([]);
    },
  );

  it.each(
    [false, true].flatMap((collected) =>
      [false, true].map((observerFails) => ({ collected, observerFails })),
    ),
  )(
    "releases consumed custody without a writer lock (collected=$collected, observerFails=$observerFails)",
    async ({ collected, observerFails }) => {
      const { receipt, sources } = await prepare(collected);
      expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
        Array(sources.length + 1).fill("queued"),
      );
      if (observerFails) {
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            deferOpenClawAgentPostCommitPublication(current, () => {
              throw new Error("postcommit observer failed");
            });
            promoteSync(receipt);
          }, options()),
        ).toThrow("postcommit observer failed");
      } else {
        expect(
          await receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message })),
        ).toMatchObject({ appended: true });
      }
      expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
        Array(sources.length + 1).fill("consumed"),
      );
      expect(receipt.run(() => true)).toBe(true);
      const primary = database();
      const foreign = new DatabaseSync(primary.path);
      try {
        foreign.exec("BEGIN IMMEDIATE");
        runWithSqliteBusyTimeout(primary.db, 1, () => {
          expect(() => receipt.finish("cancelled")).not.toThrow();
          for (const source of sources) {
            expect(() => source.run(() => {})).toThrow("ownership ended");
          }
          expect(foreign.isTransaction).toBe(true);
          // The foreign writer must still own its native lock after release returns.
          expect(() => primary.db.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
        });
      } finally {
        if (primary.db.isTransaction) {
          primary.db.exec("ROLLBACK");
        }
        if (foreign.isTransaction) {
          foreign.exec("ROLLBACK");
        }
        foreign.close();
      }
      expect(
        primary.db
          .prepare("SELECT state, consumed_event_id FROM session_pending_inputs ORDER BY seq")
          .all(),
      ).toEqual(
        collected
          ? sources.map(() => ({ state: "queued", consumed_event_id: receipt.inputId }))
          : [],
      );
    },
  );

  it("commits one collected message and retains exact source receipts across rewrite and restart", async () => {
    const { sessionKey } = scope();
    const firstMessage = {
      ...message("collect-a", "First approved input"),
      __openclaw: { transport: { clients: [{ id: "cli", mode: "cli", displayName: "CLI" }] } },
    };
    const secondMessage = {
      ...message("collect-b", "Second approved input"),
      __openclaw: { transport: { clients: [{ id: "openclaw-control-ui", mode: "webchat" }] } },
    };
    const first = await stage("collect-a", {
      message: firstMessage,
    });
    const second = await stage("collect-b", {
      message: secondMessage,
    });
    const aggregate = bindSessionPendingInputSources(
      [first, second],
      message("collect-c", "First approved input\nSecond approved input"),
    )!;
    receipts.push(aggregate);
    expect(listSessionPendingInputs(scope()).total).toBe(2);
    const appended = await promote(aggregate);
    expect(appended).toMatchObject({ appended: true, messageId: aggregate.inputId });
    expect(readSessionSubmittedInput(scope(), "collect-c:user")?.["__openclaw"]).toMatchObject({
      transport: {
        clients: [
          { id: "cli", mode: "cli", displayName: "CLI" },
          { id: "openclaw-control-ui", mode: "webchat" },
        ],
      },
    });
    expect(listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(readSessionPendingInput(scope(), first.inputId)).toBeUndefined();
    expect(
      listSessionPendingInputReceipts(scope(), {
        runIds: ["collect-a", "collect-b", "unknown"],
      }),
    ).toEqual([
      { runId: "collect-a", state: "consumed", consumedByEventId: aggregate.inputId },
      { runId: "collect-b", state: "consumed", consumedByEventId: aggregate.inputId },
    ]);
    aggregate.finish("cancelled");
    await replaceTranscriptEvents(scope(), []);
    rotateAgentEventLifecycleGeneration();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    expect(readSessionSubmittedInput(scope(), "collect-a:user")).toEqual(first.message);
    expect(readSessionSubmittedInput(scope(), "collect-b:user")).toEqual(second.message);
    const duplicate = await stage("collect-a", {
      message: { ...firstMessage, timestamp: 200 },
    });
    expect(duplicate).toMatchObject({
      state: "consumed",
      inputId: first.inputId,
      message: first.message,
    });
    expect(() => promote(duplicate)).toThrow("already been consumed");
    await expect(
      stage("collect-a", { message: message("collect-a", "Changed input") }),
    ).rejects.toThrow("conflicts");
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(
      database()
        .db.prepare(
          "SELECT input_id, message_json, consumed_event_id FROM session_pending_inputs ORDER BY seq",
        )
        .all(),
    ).toEqual([
      {
        input_id: first.inputId,
        message_json: JSON.stringify(first.message),
        consumed_event_id: aggregate.inputId,
      },
      {
        input_id: second.inputId,
        message_json: JSON.stringify(second.message),
        consumed_event_id: aggregate.inputId,
      },
    ]);
    expect(
      listSessionPendingInputReceipts(
        { ...scope(), sessionId: "other" },
        { runIds: ["collect-a"] },
      ),
    ).toEqual([]);
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: fixture.storePath(),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(database().db.prepare("SELECT count(*) AS n FROM session_pending_inputs").get()).toEqual(
      { n: 0 },
    );
  });

  it.each([
    "empty-metadata",
    "sender-metadata",
    "transport-metadata",
    "changed-payload",
    "changed-sender",
    "changed-provenance",
    "changed-transport",
  ] as const)("preserves legacy consumed input identity with %s", async (scenario) => {
    const originalTransport =
      scenario === "empty-metadata" || scenario === "sender-metadata"
        ? {}
        : { channel: "test", messageId: "original-message" };
    const original: PersistedUserTurnMessage = {
      ...message("legacy-client"),
      provenance: { kind: "external_user", sourceTool: "original-source" },
      ...(scenario === "empty-metadata"
        ? {}
        : {
            __openclaw: {
              senderId: "original-sender",
              ...(Object.keys(originalTransport).length ? { transport: originalTransport } : {}),
            },
          }),
    };
    const source = await stage("legacy-client", { message: original });
    const aggregate = expectDefined(
      bindSessionPendingInputSources([source], message("legacy-collector")),
      "Expected collected legacy input",
    );
    receipts.push(aggregate);
    await promote(aggregate);
    aggregate.finish("interrupted");
    const stored = () =>
      database().db.prepare("SELECT request_hash, message_json FROM session_pending_inputs").all();
    const before = stored();
    const retry: PersistedUserTurnMessage = {
      ...original,
      ...(scenario === "changed-payload" ? { content: "Changed input" } : {}),
      ...(scenario === "changed-provenance"
        ? { provenance: { kind: "external_user", sourceTool: "another-source" } }
        : {}),
      __openclaw: {
        ...original["__openclaw"],
        ...(scenario === "changed-sender" ? { senderId: "another-sender" } : {}),
        transport: {
          ...originalTransport,
          ...(scenario === "changed-transport" ? { messageId: "another-message" } : {}),
          clients: [{ id: "cli", mode: "cli" }],
        },
      },
    };
    const replay = stage("legacy-client", { message: retry, requestFingerprint: "upgraded" });
    if (scenario.startsWith("changed-")) {
      await expect(replay).rejects.toThrow("conflicts with the accepted input");
    } else {
      const receipt = await replay;
      expect(receipt).toMatchObject({ state: "consumed", message: original });
      expect(() => receipt.run(() => {})).toThrow("already been consumed");
    }
    expect(stored()).toEqual(before);
    expect(readSessionSubmittedInput(scope(), "legacy-client:user")).toEqual(original);
  });

  const stagePrivate = async (text = "private child marker", assertCurrent = () => {}) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(), {
        runId: "announce:private-child",
        trackCompletion: true,
        assertCurrent,
        message: {
          ...message("announce:private-child"),
          content: text,
          display: false,
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      }),
      "Expected private input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const completionRows = () =>
    database().db.prepare("SELECT * FROM session_input_completions").all();
  const pendingCount = () =>
    database().db.prepare("SELECT COUNT(*) AS count FROM session_pending_inputs").get()?.count;
  const transcriptRows = () =>
    database()
      .db.prepare("SELECT seq, event_json, created_at FROM transcript_events ORDER BY seq")
      .all();

  it.each(["pending", "completed", "transcript", "prepared transcript", "public pending"] as const)(
    "matches a shipped settle source by its whole request hash (%s)",
    async (state) => {
      const runId = "announce:settle-cohort";
      const original = {
        ...message(runId),
        display: false as const,
        provenance: {
          kind: "inter_session" as const,
          sourceTool: "subagent_settle",
          sourceChannel: "internal",
          sourceSessionKey: "child-b",
        },
      };
      const prepareMessageAfterIdempotencyCheck = (candidate: PersistedUserTurnMessage) =>
        state === "prepared transcript"
          ? { ...candidate, content: "Approved synthetic input" }
          : candidate;
      const first = await stage(runId, {
        message: original,
        trackCompletion: state !== "public pending",
        prepareMessageAfterIdempotencyCheck,
      });
      const originalHash = database()
        .db.prepare("SELECT request_hash FROM session_pending_inputs")
        .get()?.request_hash;
      if (state === "completed") {
        // Handled private input can leave only its hash/outcome, not a transcript.
        first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
        expect(readSessionSubmittedInput(scope(), `${runId}:user`)).toBeUndefined();
      }
      if (state.endsWith("transcript")) {
        promoteSync(first);
        expect(pendingCount()).toBe(0);
        expect(completionRows()).toEqual([]);
      }
      first.finish("interrupted");
      const acceptedOrder = () =>
        database()
          .db.prepare(
            "SELECT seq, input_id, request_hash, message_json, accepted_at FROM session_pending_inputs ORDER BY seq",
          )
          .all();
      const beforeReplay = acceptedOrder();
      const beforeTranscript = transcriptRows();
      rotateAgentEventLifecycleGeneration();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const replay = stage(runId, {
        message: {
          ...original,
          provenance: { ...original.provenance, sourceSessionKey: "child-a" },
        },
        trackCompletion: state !== "public pending",
        replaySourceSessionKeys: ["child-a", "child-b"],
        prepareMessageAfterIdempotencyCheck,
      });
      if (state === "public pending") {
        // Matching identity never grants ordinary input new execution custody.
        await expect(replay).rejects.toThrow("Pending input ownership ended");
        expect(acceptedOrder()).toEqual(beforeReplay);
        return;
      }
      const receipt = await replay;
      expect(acceptedOrder()).toEqual(beforeReplay);
      expect(receipt.message.provenance).toEqual(original.provenance);
      if (state === "completed") {
        expect(receipt.completion).toMatchObject({ reason: "completed" });
        expect(() => receipt.run(() => {})).toThrow("already completed");
      } else {
        expect(receipt.completion).toBeUndefined();
        expect(receipt.run(() => "resumed")).toBe("resumed");
        receipt.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
        expect(completionRows()).toMatchObject([{ request_hash: originalHash }]);
      }
      expect(transcriptRows()).toEqual(beforeTranscript);
    },
  );

  it.each([
    ...(
      ["content", "sender", "tool", "run", "outside cohort", "session", "authority"] as const
    ).map((difference) => ({ state: "completed" as const, difference })),
    ...(["content", "run", "outside cohort", "authority after prepare", "malformed"] as const).map(
      (difference) => ({ state: "transcript" as const, difference }),
    ),
  ])(
    "does not substitute a settle $state when $difference differs",
    async ({ state, difference }) => {
      const runId = "announce:guarded-settle";
      const original = {
        ...message(runId),
        __openclaw: { senderIsOwner: false, senderId: "original" },
        provenance: {
          kind: "inter_session" as const,
          sourceTool: "subagent_settle",
          sourceChannel: "internal",
          sourceSessionKey: "child-b",
        },
      };
      const first = await stage(runId, { message: original, trackCompletion: true });
      if (state === "transcript") {
        promoteSync(first);
        if (difference === "malformed") {
          database()
            .db.prepare(
              "UPDATE transcript_events SET event_json = json_set(event_json, '$.message.role', 'assistant') WHERE json_extract(event_json, '$.message.idempotencyKey') = ?",
            )
            .run(`${runId}:user`);
        }
      } else {
        first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      }
      first.finish("interrupted");
      const before = completionRows();
      const beforeTranscript = transcriptRows();
      if (difference === "session") {
        await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
      }
      let current = true;
      const replay = stageSessionPendingInput(scope(), {
        runId: difference === "run" ? "announce:other-run" : runId,
        trackCompletion: true,
        replaySourceSessionKeys:
          difference === "outside cohort" ? ["child-a"] : ["child-a", "child-b"],
        assertCurrent: () => {
          if (difference === "authority" || !current) {
            throw new Error("source owner changed");
          }
        },
        prepareMessageAfterIdempotencyCheck: (candidate) => {
          if (difference === "authority after prepare") {
            current = false;
          }
          return candidate;
        },
        message: {
          ...original,
          ...(difference === "content" ? { content: "different result" } : {}),
          ...(difference === "sender"
            ? { __openclaw: { senderIsOwner: false, senderId: "other" } }
            : {}),
          provenance: {
            ...original.provenance,
            sourceSessionKey: "child-a",
            ...(difference === "tool" ? { sourceTool: "sessions_send" } : {}),
          },
        },
      });
      if (difference === "session") {
        await expect(replay).resolves.toBeUndefined();
      } else {
        await expect(replay).rejects.toThrow(
          difference === "tool"
            ? "requires an internal settle request"
            : difference === "authority" || difference === "authority after prepare"
              ? "source owner changed"
              : difference === "malformed"
                ? "invalid persisted user message"
                : state === "transcript"
                  ? difference === "run"
                    ? "conflicts with the accepted run"
                    : difference === "outside cohort"
                      ? "committed source is outside the frozen settle cohort"
                      : "conflicts with the committed input"
                  : "conflicts with the accepted input",
        );
      }
      expect(completionRows()).toEqual(before);
      expect(transcriptRows()).toEqual(beforeTranscript);
    },
  );

  it.each(["missing", "outside cohort", "wrong tool"] as const)(
    "rejects a committed %s source before lossy preparation",
    async (source) => {
      const runId = "announce:lossy-settle";
      const incoming: PersistedUserTurnMessage = {
        ...message(runId),
        provenance: {
          kind: "inter_session",
          sourceTool: "subagent_settle",
          sourceSessionKey: "child-b",
        },
      };
      const committedProvenance =
        source === "missing"
          ? undefined
          : {
              kind: "inter_session" as const,
              sourceTool: source === "wrong tool" ? "sessions_send" : "subagent_settle",
              sourceSessionKey: source === "outside cohort" ? "child-outside" : "child-b",
            };
      const lossyPrepare = (candidate: PersistedUserTurnMessage): PersistedUserTurnMessage => {
        const { provenance: _provenance, ...rest } = candidate;
        return { ...rest, ...(committedProvenance ? { provenance: committedProvenance } : {}) };
      };
      const first = await stage(runId, {
        message: incoming,
        trackCompletion: true,
        prepareMessageAfterIdempotencyCheck: lossyPrepare,
      });
      promoteSync(first);
      first.finish("interrupted");
      expect(pendingCount()).toBe(0);
      expect(completionRows()).toEqual([]);
      const before = transcriptRows();
      let preparations = 0;
      await expect(
        stage(runId, {
          message: incoming,
          trackCompletion: true,
          replaySourceSessionKeys: ["child-a", "child-b"],
          prepareMessageAfterIdempotencyCheck: (candidate) => {
            preparations += 1;
            return lossyPrepare(candidate);
          },
        }),
      ).rejects.toThrow("committed source is outside the frozen settle cohort");
      expect(preparations).toBe(0);
      expect(completionRows()).toEqual([]);
      expect(transcriptRows()).toEqual(before);
    },
  );

  it("opens a same-version store without completion tracking and installs it only on private use", async () => {
    const version = database().db.prepare("PRAGMA user_version").get();
    database().db.exec("DROP TABLE session_input_completions");
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const hasCompletionTable = () =>
      Boolean(
        database()
          .db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_input_completions'")
          .get(),
      );
    expect(hasCompletionTable()).toBe(false);
    const ordinary = await stage("ordinary-without-feature");
    expect(hasCompletionTable()).toBe(false);
    ordinary.finish("cancelled");
    await stagePrivate();
    expect(hasCompletionTable()).toBe(true);
    expect(database().db.prepare("PRAGMA user_version").get()).toEqual(version);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    expect(hasCompletionTable()).toBe(true);
  });

  it("preserves a message-hook veto when retrying already committed private input", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    first.finish("interrupted");
    const replay = await stageSessionPendingInput(scope(), {
      runId: "announce:private-child",
      trackCompletion: true,
      assertCurrent: () => {},
      message: first.message,
      prepareMessageAfterIdempotencyCheck: () => undefined,
    });
    expect(replay).toBeUndefined();
    expect(completionRows()).toEqual([]);
  });

  it.each([false, true])(
    "retains operator cancellation across restart (input consumed=%s)",
    async (consumed) => {
      const first = await stagePrivate();
      if (consumed) {
        promoteSync(first);
      }
      const cancelled = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });
      first.complete!(cancelled);
      expect(first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }))).toEqual(cancelled);
      expect(pendingCount()).toBe(0);
      rotateAgentEventLifecycleGeneration();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const retry = await stagePrivate();
      expect(retry.completion).toMatchObject({ reason: "cancelled", stopReason: "rpc" });
      expect(() => retry.run(() => "stopped work")).toThrow("already completed");
      expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
    },
  );

  it("retries a restart interruption instead of treating it as an operator stop", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    first.complete!(buildAgentRunTerminalOutcome({ status: "timeout", stopReason: "restart" }));
    first.finish("interrupted");
    rotateAgentEventLifecycleGeneration();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const retry = await stagePrivate();
    expect(retry.completion).toBeUndefined();
    retry.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
  });

  it.each([false, true])(
    "reconciles successful private processing after restart (input consumed=%s)",
    async (consumed) => {
      const first = await stagePrivate();
      if (consumed) {
        promoteSync(first);
      }
      let nextSpawns = 0;
      nextSpawns += 1;
      first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      expect(pendingCount()).toBe(0);
      expect(completionRows()).toMatchObject([{ succeeded: 1, run_id: "announce:private-child" }]);
      // The child delivery save has not happened. A fresh process has only the DB.
      rotateAgentEventLifecycleGeneration();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const replay = await stagePrivate();
      expect(replay.completion).toMatchObject({ status: "ok", reason: "completed" });
      expect(() =>
        replay.run(() => {
          nextSpawns += 1;
        }),
      ).toThrow("already completed");
      expect(nextSpawns).toBe(1);
      expect(pendingCount()).toBe(0);
      await expect(stagePrivate("different child marker")).rejects.toThrow("conflicts");
    },
  );

  it.each([false, true])(
    "retains uncompleted private work across restart (input consumed=%s)",
    async (consumed) => {
      const first = await stagePrivate();
      if (consumed) {
        promoteSync(first);
      }
      expect(completionRows()).toEqual([]);
      rotateAgentEventLifecycleGeneration();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const resumed = await stagePrivate();
      expect(resumed.completion).toBeUndefined();
      expect(resumed.run(() => "one resumed execution")).toBe("one resumed execution");
      resumed.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      expect(pendingCount()).toBe(0);
      expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
      await expect(stagePrivate("changed committed payload")).rejects.toThrow("conflicts");
    },
  );

  it("keeps private failed attempts retryable without letting stale failure replace success", async () => {
    const first = await stagePrivate();
    first.complete!(
      buildAgentRunTerminalOutcome({ status: "error", error: "provider unavailable" }),
    );
    expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
    first.finish("interrupted");
    const retry = await stagePrivate();
    retry.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
    expect(() => first.complete!(buildAgentRunTerminalOutcome({ status: "error" }))).toThrow(
      "released",
    );
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
    expect(pendingCount()).toBe(0);
  });

  it("rolls back private success and input retirement together", async () => {
    const first = await stagePrivate();
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
        throw new Error("before commit");
      }, options()),
    ).toThrow("before commit");
    expect(completionRows()).toEqual([]);
    expect(pendingCount()).toBe(1);
    first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
    expect(pendingCount()).toBe(0);
  });

  it("keeps committed private success when a postcommit observer fails", async () => {
    const first = await stagePrivate();
    expect(() =>
      runOpenClawAgentWriteTransaction((current) => {
        deferOpenClawAgentPostCommitPublication(current, () => {
          throw new Error("observer failed");
        });
        first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      }, options()),
    ).toThrow("observer failed");
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
    expect(pendingCount()).toBe(0);
  });

  it.each(["owner", "session", "lifecycle"] as const)(
    "rejects a private completion after %s changes",
    async (boundary) => {
      let current = true;
      const first = await stagePrivate("private child marker", () => {
        if (!current) {
          throw new Error("owner changed");
        }
      });
      if (boundary === "owner") {
        current = false;
      }
      if (boundary === "session") {
        await upsertSessionEntryCore(scope(), { sessionId: "replacement-parent", updatedAt: 2 });
      }
      if (boundary === "lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      expect(() => first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }))).toThrow();
      expect(completionRows()).toEqual([]);
    },
  );

  it.each(
    [false, true].flatMap((collected) =>
      ["outer", "savepoint"].map((rollback) => ({ collected, rollback })),
    ),
  )(
    "still terminalizes input after staged consumption rolls back (collected=$collected, rollback=$rollback)",
    async ({ collected, rollback }) => {
      const { receipt, sources } = await prepare(collected);
      const consumeThenFail = () => {
        promoteSync(receipt);
        throw new Error("rollback after consumption");
      };
      if (rollback === "outer") {
        expect(() => runOpenClawAgentWriteTransaction(consumeThenFail, options())).toThrow(
          "rollback after consumption",
        );
      } else {
        runOpenClawAgentWriteTransaction(() => {
          expect(() => runOpenClawAgentWriteTransaction(consumeThenFail, options())).toThrow(
            "rollback after consumption",
          );
        }, options());
      }
      expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
        Array(sources.length + 1).fill("queued"),
      );
      receipt.finish("cancelled");
      expect(
        database()
          .db.prepare("SELECT state, consumed_event_id FROM session_pending_inputs ORDER BY seq")
          .all(),
      ).toEqual(sources.map(() => ({ state: "cancelled", consumed_event_id: null })));
    },
  );
});
