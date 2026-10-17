import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionPendingInputReceiptsInWorker as listSessionPendingInputReceipts } from "./session-pending-input-receipts.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { deriveTranscriptPredicateFields } from "./transcript-predicate-fields.js";

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

  const complete = (
    receipt: SessionPendingInputReceipt,
    outcome: Parameters<typeof buildAgentRunTerminalOutcome>[0],
  ) => receipt.completeAsync!(buildAgentRunTerminalOutcome(outcome));
  const finish = async (
    receipt: SessionPendingInputReceipt,
    reason: Parameters<SessionPendingInputReceipt["finish"]>[0] = "interrupted",
  ) => {
    receipt.finish(reason);
    await receipt.settled?.();
  };
  const restart = async () => {
    rotateAgentEventLifecycleGeneration();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  };
  const rows = (sql: string) => database().db.prepare(sql).all();
  const collect = (
    sources: SessionPendingInputReceipt[],
    collectedMessage: PersistedUserTurnMessage,
  ) => {
    const receipt = expectDefined(
      bindSessionPendingInputSources(sources, collectedMessage),
      "Expected collected input custody",
    );
    receipts.push(receipt);
    return receipt;
  };

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    const retained = receipts.splice(0);
    for (const receipt of retained) {
      receipt.finish("interrupted");
    }
    await Promise.allSettled(retained.map(async (receipt) => receipt.settled?.()));
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

  it.each([
    { collected: false, observerFails: false },
    { collected: true, observerFails: true },
  ])(
    "releases consumed custody without a writer lock (collected=$collected, observerFails=$observerFails)",
    async ({ collected, observerFails }) => {
      const { receipt, sources } = await prepare(collected);
      expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
        Array(sources.length + 1).fill("queued"),
      );
      if (observerFails) {
        setLoggerOverride({ level: "silent", consoleLevel: "error" });
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => {
          errorLog.mockRestore();
          resetLogger();
        });
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            deferOpenClawAgentPostCommitPublication(current, () => {
              throw new Error("postcommit observer failed");
            });
            promoteSync(receipt);
          }, options()),
        ).not.toThrow();
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("SQLite post-commit notification failed"),
        );
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
        runWithSqliteBusyTimeout(requireNativeSqliteDatabase(primary.db), 1, () => {
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
    const aggregate = collect(
      [first, second],
      message("collect-c", "First approved input\nSecond approved input"),
    );
    expect((await listSessionPendingInputs(scope())).total).toBe(2);
    const appended = await promote(aggregate);
    expect(appended).toMatchObject({ appended: true, messageId: aggregate.inputId });
    expect(
      (await readSessionSubmittedInput(scope(), "collect-c:user"))?.["__openclaw"],
    ).toMatchObject({
      transport: {
        clients: [
          { id: "cli", mode: "cli", displayName: "CLI" },
          { id: "openclaw-control-ui", mode: "webchat" },
        ],
      },
    });
    expect(await listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(await readSessionPendingInput(scope(), first.inputId)).toBeUndefined();
    expect(
      await listSessionPendingInputReceipts(scope(), {
        runIds: ["collect-a", "collect-b", "unknown"],
      }),
    ).toEqual([
      { runId: "collect-a", state: "consumed", consumedByEventId: aggregate.inputId },
      { runId: "collect-b", state: "consumed", consumedByEventId: aggregate.inputId },
    ]);
    await finish(aggregate, "cancelled");
    await replaceTranscriptEvents(scope(), []);
    await restart();
    expect(await readSessionSubmittedInput(scope(), "collect-a:user")).toEqual(first.message);
    expect(await readSessionSubmittedInput(scope(), "collect-b:user")).toEqual(second.message);
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
    expect(await listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(
      rows(
        "SELECT input_id, message_json, consumed_event_id FROM session_pending_inputs ORDER BY seq",
      ),
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
      await listSessionPendingInputReceipts(
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

  it.each(["empty-metadata", "transport-metadata", "changed-payload"] as const)(
    "preserves legacy consumed input identity with %s",
    async (scenario) => {
      const originalTransport =
        scenario === "empty-metadata" ? {} : { channel: "test", messageId: "original-message" };
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
      const aggregate = collect([source], message("legacy-collector"));
      await promote(aggregate);
      await finish(aggregate);
      const stored = () => rows("SELECT request_hash, message_json FROM session_pending_inputs");
      const before = stored();
      const retry: PersistedUserTurnMessage = {
        ...original,
        ...(scenario === "changed-payload" ? { content: "Changed input" } : {}),
        __openclaw: {
          ...original["__openclaw"],
          transport: {
            ...originalTransport,
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
      expect(await readSessionSubmittedInput(scope(), "legacy-client:user")).toEqual(original);
    },
  );

  const stagePrivate = (text = "private child marker", assertCurrent = () => {}) =>
    stage("announce:private-child", {
      trackCompletion: true,
      assertCurrent,
      message: {
        ...message("announce:private-child"),
        content: text,
        display: false,
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
    });
  const completionRows = () => rows("SELECT * FROM session_input_completions");
  const pendingCount = () =>
    database().db.prepare("SELECT COUNT(*) AS count FROM session_pending_inputs").get()?.count;
  const transcriptRows = () =>
    rows("SELECT seq, event_json, created_at FROM transcript_events ORDER BY seq");

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
        await complete(first, { status: "ok" });
        expect(await readSessionSubmittedInput(scope(), `${runId}:user`)).toBeUndefined();
      }
      if (state.endsWith("transcript")) {
        promoteSync(first);
        expect(pendingCount()).toBe(0);
        expect(completionRows()).toEqual([]);
      }
      await finish(first);
      const acceptedOrder = () =>
        rows(
          "SELECT seq, input_id, request_hash, message_json, accepted_at FROM session_pending_inputs ORDER BY seq",
        );
      const beforeReplay = acceptedOrder();
      const beforeTranscript = transcriptRows();
      await restart();
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
        await complete(receipt, { status: "ok" });
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
              "UPDATE transcript_events SET event_json = json_set(event_json, '$.message.role', 'assistant'), message_role = ? WHERE json_extract(event_json, '$.message.idempotencyKey') = ?",
            )
            .run(
              deriveTranscriptPredicateFields('{"message":{"role":"assistant"}}').message_role,
              `${runId}:user`,
            );
        }
      } else {
        await complete(first, { status: "ok" });
      }
      await finish(first);
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
      await finish(first);
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
    await finish(ordinary, "cancelled");
    const privateInput = await stagePrivate();
    expect(hasCompletionTable()).toBe(true);
    expect(database().db.prepare("PRAGMA user_version").get()).toEqual(version);
    await finish(privateInput);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    expect(hasCompletionTable()).toBe(true);
  });

  it("preserves a message-hook veto when retrying already committed private input", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    await finish(first);
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

  it("retains operator cancellation across restart after transcript consumption", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    const cancelled = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });
    await first.completeAsync!(cancelled);
    expect(await complete(first, { status: "ok" })).toEqual(cancelled);
    expect(pendingCount()).toBe(0);
    rotateAgentEventLifecycleGeneration();
    await first.settled?.();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const retry = await stagePrivate();
    expect(retry.completion).toMatchObject({ reason: "cancelled", stopReason: "rpc" });
    expect(() => retry.run(() => "stopped work")).toThrow("already completed");
    expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
  });

  it("retries a restart interruption instead of treating it as an operator stop", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    await complete(first, { status: "timeout", stopReason: "restart" });
    await finish(first);
    await restart();
    const retry = await stagePrivate();
    expect(retry.completion).toBeUndefined();
    await complete(retry, { status: "ok" });
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
  });

  it.each(["pending", "interrupted", "consumed", "completed"] as const)(
    "reconciles saved peer delivery identity after restart (%s)",
    async (state) => {
      const runId = "peer-restart";
      const original: PersistedUserTurnMessage = {
        ...message(runId),
        provenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceSessionKey: "agent:main:source",
        },
        __openclaw: {
          sessionSendDelivery: {
            version: 1,
            runId,
            source: {
              agentId: "main",
              sessionKey: "agent:main:source",
              sessionId: "source-id",
              lifecycleRevision: undefined,
            },
            target: {
              agentId: "main",
              sessionKey: scope().sessionKey,
              sessionId: scope().sessionId,
              lifecycleRevision: undefined,
            },
            sandboxed: false,
            message: "Synthetic accepted input",
          },
        },
      };
      const first = await stage(runId, { message: original, trackCompletion: true });
      if (state === "consumed" || state === "completed") {
        await promote(first);
      }
      if (state !== "pending") {
        await first.completeAsync!(
          buildAgentRunTerminalOutcome(
            state === "completed" ? { status: "ok" } : { status: "error", stopReason: "restart" },
          ),
        );
      }
      await finish(first);
      await restart();

      const saved = expectDefined(
        await readSessionSubmittedInput(scope(), `${runId}:user`),
        "Expected saved peer input after restart",
      );
      // SQLite JSON omits undefined endpoint revisions; recovery must match the original hash.
      expect(JSON.stringify(saved)).not.toContain("lifecycleRevision");
      await expect(
        stage(runId, { message: { ...saved, content: "Different input" }, trackCompletion: true }),
      ).rejects.toThrow("conflicts");
      const recovered = await stage(runId, { message: saved, trackCompletion: true });
      expect(recovered.message).toEqual(saved);
      if (state === "completed") {
        expect(recovered.completion).toMatchObject({ reason: "completed" });
        expect(() => recovered.run(() => {})).toThrow("already completed");
      } else {
        expect(recovered.completion).toBeUndefined();
        await complete(recovered, { status: "ok" });
      }
    },
  );

  it("keeps private failed attempts retryable without letting stale failure replace success", async () => {
    const first = await stagePrivate();
    await complete(first, { status: "error", error: "provider unavailable" });
    expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
    await finish(first);
    const retry = await stagePrivate();
    await complete(retry, { status: "ok" });
    expect(await complete(first, { status: "error" })).toMatchObject({
      error: "provider unavailable",
    });
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
      await expect(async () => complete(first, { status: "ok" })).rejects.toThrow();
      expect(completionRows()).toEqual([]);
    },
  );

  it.each([
    { collected: true, rollback: "outer" },
    { collected: false, rollback: "savepoint" },
  ])(
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
      await finish(receipt, "cancelled");
      expect(
        rows("SELECT state, consumed_event_id FROM session_pending_inputs ORDER BY seq"),
      ).toEqual(sources.map(() => ({ state: "cancelled", consumed_event_id: null })));
    },
  );
});
