import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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

const fixture = useTempSessionsFixture("pending-input-consumed-release-");
const scope = () => ({
  agentId: "main",
  sessionKey: "agent:main:consumed-release",
  sessionId: "consumed-session",
  storePath: fixture.storePath(),
});
const options = () => toDatabaseOptions(resolveSqliteScope(scope()));
const database = () => openOpenClawAgentDatabase(options());
const query = (sql: string) => database().db.prepare(sql);
const rows = (sql: string) => query(sql).all();
const pendingRows = (fields: string) =>
  rows(`SELECT ${fields} FROM session_pending_inputs ORDER BY seq`);
const receipts: SessionPendingInputReceipt[] = [];
const message = (id: string, content = "Synthetic accepted input") => ({
  role: "user" as const,
  content,
  timestamp: 1,
  idempotencyKey: `${id}:user`,
});
const internalMessage = (
  id: string,
  sourceTool: string,
  sourceSessionKey?: string,
  sourceChannel?: string,
) => ({
  ...message(id),
  provenance: {
    kind: "inter_session" as const,
    sourceTool,
    ...(sourceSessionKey ? { sourceSessionKey } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
  },
});
const settleMessage = (id: string) => internalMessage(id, "subagent_settle", "child-b", "internal");
const request = (
  runId: string,
  opts: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
) =>
  stageSessionPendingInput(scope(), {
    runId,
    message: message(runId),
    assertCurrent: () => {},
    ...opts,
  });
const stage = async (
  id: string,
  stageOptions: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
) => {
  const receipt = expectDefined(await request(id, stageOptions), "Expected staged input custody");
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
  return { receipt: collect(sources, message("aggregate")), sources };
};
const promoteSync = (receipt: SessionPendingInputReceipt) =>
  expect(
    receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
  ).toMatchObject({ ok: true, value: { appended: true } });
const promote = (receipt: SessionPendingInputReceipt) => receipt.run(() => append(receipt));

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
const close = async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
};
const restart = async () => {
  rotateAgentEventLifecycleGeneration();
  await close();
};
const expectStates = (inputs: SessionPendingInputReceipt[], state: string) =>
  expect(inputs.map((input) => input.state)).toEqual(inputs.map(() => state));
const append = (receipt: SessionPendingInputReceipt) =>
  appendTranscriptMessage(scope(), { message: receipt.message });
const persist = (receipt: SessionPendingInputReceipt) =>
  withSessionPendingInputPersistence(receipt, () => append(receipt));
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
  await close();
});

it.each([false, true])(
  "permits exact persistence after custody closes (collected: %s)",
  async (collected) => {
    const source = await stage("closed-persistence");
    const receipt = collected ? collect([source], message("closed-aggregate")) : source;
    await promote(receipt);
    receipt.finish("cancelled");
    expect(() => receipt.run(() => {})).toThrow("ownership ended");
    const before = await loadTranscriptEvents(scope());
    expect(await persist(receipt)).toMatchObject({ appended: false, messageId: receipt.inputId });
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    await replaceTranscriptEvents(scope(), []);
    await expect(persist(receipt)).rejects.toThrow("custody ended");
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  },
);

it.each([
  { collected: false, observerFails: false },
  { collected: true, observerFails: true },
])(
  "releases custody without a writer lock ($collected, $observerFails)",
  async ({ collected, observerFails }) => {
    const { receipt, sources } = await prepare(collected);
    expectStates([receipt, ...sources], "queued");
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
      expect(await promote(receipt)).toMatchObject({ appended: true });
    }
    expectStates([receipt, ...sources], "consumed");
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
    expect(pendingRows("state, consumed_event_id")).toEqual(
      collected ? sources.map(() => ({ state: "queued", consumed_event_id: receipt.inputId })) : [],
    );
  },
);

it("commits one collected message and retains exact source receipts across rewrite and restart", async () => {
  const { sessionKey } = scope();
  const clients = [
    { id: "cli", mode: "cli", displayName: "CLI" },
    { id: "openclaw-control-ui", mode: "webchat" },
  ] as const;
  const stageClient = (id: string, content: string, index: 0 | 1) =>
    stage(id, {
      message: {
        ...message(id, content),
        __openclaw: { transport: { clients: [clients[index]] } },
      },
    });
  const first = await stageClient("collect-a", "First approved input", 0);
  const second = await stageClient("collect-b", "Second approved input", 1);
  const aggregate = collect(
    [first, second],
    message("collect-c", "First approved input\nSecond approved input"),
  );
  expect((await listSessionPendingInputs(scope())).total).toBe(2);
  const appended = await promote(aggregate);
  expect(appended).toMatchObject({ appended: true, messageId: aggregate.inputId });
  expect(
    (await readSessionSubmittedInput(scope(), "collect-c:user"))?.["__openclaw"],
  ).toMatchObject({ transport: { clients } });
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
    message: { ...first.message, timestamp: 200 },
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
  expect(pendingRows("input_id, message_json, consumed_event_id")).toEqual(
    [first, second].map((source) => ({
      input_id: source.inputId,
      message_json: JSON.stringify(source.message),
      consumed_event_id: aggregate.inputId,
    })),
  );
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
  expect(query("SELECT count(*) AS n FROM session_pending_inputs").get()).toEqual({ n: 0 });
});

it.each(["empty-metadata", "transport-metadata", "changed-payload", "changed-sender"] as const)(
  "preserves legacy consumed input identity with %s",
  async (scenario) => {
    const empty = scenario === "empty-metadata";
    const originalTransport = empty ? {} : { channel: "test", messageId: "original-message" };
    const original: PersistedUserTurnMessage = {
      ...message("legacy-client"),
      provenance: { kind: "external_user", sourceTool: "original-source" },
      ...(empty
        ? {}
        : { __openclaw: { senderId: "original-sender", transport: originalTransport } }),
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
        ...(scenario === "changed-sender" ? { senderId: "different-sender" } : {}),
        requesterOrigin: {
          sessionKey: scope().sessionKey,
          messageProvider: "telegram",
          senderId: "original-sender",
        },
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

const stagePrivate = (assertCurrent = () => {}, retryCancelled = false) =>
  stage("announce:private-child", {
    trackCompletion: true,
    assertCurrent,
    retryCancelled,
    message: {
      ...internalMessage("announce:private-child", "subagent_announce"),
      content: "private child marker",
      display: false,
    },
  });
const completionRows = () => rows("SELECT * FROM session_input_completions");
const pendingCount = () =>
  query("SELECT COUNT(*) AS count FROM session_pending_inputs").get()?.count;
const transcriptRows = () =>
  rows("SELECT seq, event_json, created_at FROM transcript_events ORDER BY seq");
const snapshot = () => ({ completions: completionRows(), transcript: transcriptRows() });

it("retains collected source correlation when private completion commits", async () => {
  const source = await stagePrivate();
  const aggregate = collect([source], message("private-aggregate"));
  await expect(promote(aggregate)).resolves.toMatchObject({
    appended: true,
    messageId: aggregate.inputId,
  });
  const consumed = [
    {
      runId: "announce:private-child",
      state: "consumed",
      consumedByEventId: aggregate.inputId,
    },
  ];
  const readReceipts = () =>
    listSessionPendingInputReceipts(scope(), {
      runIds: ["announce:private-child"],
    });
  expect(await readReceipts(), "collected source after transcript promotion").toEqual(consumed);
  const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
  await expect(source.completeAsync!(outcome)).resolves.toEqual(outcome);
  expect(await readReceipts(), "collected source after private completion").toEqual(consumed);
  await restart();
  const replay = await stagePrivate();
  expect(replay.completion).toEqual(outcome);
  expect(() => replay.run(() => "duplicate private work")).toThrow("already completed");
  expect(await readReceipts(), "collected source after database reopen").toEqual(consumed);
});

it.each(["pending", "completed", "transcript", "prepared transcript", "public pending"] as const)(
  "matches a shipped settle source by its whole request hash (%s)",
  async (state) => {
    const runId = "announce:settle-cohort";
    const original = { ...settleMessage(runId), display: false as const };
    const prepareMessageAfterIdempotencyCheck = (candidate: PersistedUserTurnMessage) =>
      state === "prepared transcript"
        ? { ...candidate, content: "Approved synthetic input" }
        : candidate;
    const first = await stage(runId, {
      message: original,
      trackCompletion: state !== "public pending",
      prepareMessageAfterIdempotencyCheck,
    });
    const originalHash = query("SELECT request_hash FROM session_pending_inputs").get()
      ?.request_hash;
    if (state === "completed") {
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
      pendingRows("seq, input_id, request_hash, message_json, accepted_at");
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
    if (state === "public pending" || state === "pending") {
      await expect(replay).rejects.toThrow("Pending input ownership ended");
      expect(acceptedOrder()).toEqual(beforeReplay);
      expect(transcriptRows()).toEqual(beforeTranscript);
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
  ["completed", "content", "conflicts with the accepted input"],
  ["completed", "sender", "conflicts with the accepted input"],
  ["completed", "tool", "requires an internal settle request"],
  ["completed", "run", "conflicts with the accepted input"],
  ["completed", "outside cohort", "conflicts with the accepted input"],
  ["completed", "session", undefined],
  ["completed", "authority", "source owner changed"],
  ["transcript", "content", "conflicts with the committed input"],
  ["transcript", "run", "conflicts with the accepted run"],
  ["transcript", "outside cohort", "committed source is outside the frozen settle cohort"],
  ["transcript", "authority after prepare", "source owner changed"],
  ["transcript", "malformed", "invalid persisted user message"],
] as const)("does not substitute a settle %s when %s differs", async (state, difference, error) => {
  const runId = "announce:guarded-settle";
  const original = {
    ...settleMessage(runId),
    __openclaw: { senderIsOwner: false, senderId: "original" },
  };
  const first = await stage(runId, { message: original, trackCompletion: true });
  if (state === "transcript") {
    promoteSync(first);
    if (difference === "malformed") {
      query(
        "UPDATE transcript_events SET event_json = json_set(event_json, '$.message.role', 'assistant'), message_role = ? WHERE json_extract(event_json, '$.message.idempotencyKey') = ?",
      ).run(
        deriveTranscriptPredicateFields('{"message":{"role":"assistant"}}').message_role,
        `${runId}:user`,
      );
    }
  } else {
    await complete(first, { status: "ok" });
  }
  await finish(first);
  const before = snapshot();
  if (difference === "session") {
    await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
  }
  let current = true;
  const replay = request(difference === "run" ? "announce:other-run" : runId, {
    trackCompletion: true,
    replaySourceSessionKeys: difference === "outside cohort" ? ["child-a"] : ["child-a", "child-b"],
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
  if (error === undefined) {
    await expect(replay).resolves.toBeUndefined();
  } else {
    await expect(replay).rejects.toThrow(error);
  }
  expect(snapshot()).toEqual(before);
});

it.each(["missing", "outside cohort", "wrong tool"] as const)(
  "rejects a committed %s source before lossy preparation",
  async (source) => {
    const runId = "announce:lossy-settle";
    const incoming = internalMessage(runId, "subagent_settle", "child-b");
    const committedProvenance =
      source === "missing"
        ? undefined
        : {
            ...incoming.provenance,
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
  const version = query("PRAGMA user_version").get();
  database().db.exec("DROP TABLE session_input_completions");
  await close();
  const hasCompletionTable = () =>
    Boolean(query("SELECT 1 FROM sqlite_schema WHERE name = 'session_input_completions'").get());
  expect(hasCompletionTable()).toBe(false);
  const ordinary = await stage("ordinary-without-feature");
  expect(hasCompletionTable()).toBe(false);
  await finish(ordinary, "cancelled");
  const privateInput = await stagePrivate();
  expect(hasCompletionTable()).toBe(true);
  expect(query("PRAGMA user_version").get()).toEqual(version);
  await finish(privateInput);
  await close();
  expect(hasCompletionTable()).toBe(true);
});

it("preserves a message-hook veto when retrying already committed private input", async () => {
  const first = await stagePrivate();
  promoteSync(first);
  await finish(first);
  const replay = await request("announce:private-child", {
    trackCompletion: true,
    message: first.message,
    prepareMessageAfterIdempotencyCheck: () => undefined,
  });
  expect(replay).toBeUndefined();
  expect(completionRows()).toEqual([]);
});

it.each([
  ["operator stop", { status: "error", stopReason: "rpc" }],
  ["provider failure", { status: "error", error: "provider unavailable" }],
] as const)("preserves private retry semantics after %s", async (kind, outcome) => {
  const first = await stagePrivate();
  if (kind !== "provider failure") {
    promoteSync(first);
  }
  const terminal = buildAgentRunTerminalOutcome(outcome);
  await first.completeAsync!(terminal);
  if (kind === "operator stop") {
    expect(await complete(first, { status: "ok" })).toEqual(terminal);
    expect(pendingCount()).toBe(0);
    rotateAgentEventLifecycleGeneration();
    await first.settled?.();
    await close();
  } else {
    expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
    await finish(first, "cancelled");
  }
  const retry = await stagePrivate(undefined, kind === "provider failure");
  if (kind === "operator stop") {
    expect(retry.completion).toMatchObject({ reason: "cancelled", stopReason: "rpc" });
    expect(() => retry.run(() => "stopped work")).toThrow("already completed");
    expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
  } else {
    expect(retry.completion).toBeUndefined();
    await complete(retry, { status: "ok" });
    expect(await complete(first, { status: "error" })).toMatchObject({
      error: "provider unavailable",
    });
    expect(pendingCount()).toBe(0);
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
  }
});

it.each(["owner", "session", "lifecycle"] as const)(
  "rejects a private completion after %s changes",
  async (boundary) => {
    let current = true;
    const first = await stagePrivate(() => {
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
  "terminalizes rolled-back consumption ($collected, $rollback)",
  async ({ collected, rollback }) => {
    const { receipt, sources } = await prepare(collected);
    const consumeThenFail = () => {
      promoteSync(receipt);
      throw new Error("rollback after consumption");
    };
    const expectRollback = () =>
      expect(() => runOpenClawAgentWriteTransaction(consumeThenFail, options())).toThrow(
        "rollback after consumption",
      );
    if (rollback === "outer") {
      expectRollback();
    } else {
      runOpenClawAgentWriteTransaction(expectRollback, options());
    }
    expectStates([receipt, ...sources], "queued");
    await finish(receipt, "cancelled");
    expect(pendingRows("state, consumed_event_id")).toEqual(
      sources.map(() => ({ state: "cancelled", consumed_event_id: null })),
    );
  },
);
