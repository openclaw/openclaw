import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import {
  readSessionSubmittedInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../config/sessions/session-accessor.pending-inputs.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import {
  createIncognitoPendingInputHistoryReader,
  listSessionPendingInputs,
  readSessionPendingInput,
} from "../config/sessions/session-pending-input-history.js";
import { readSessionPendingInputReceiptsInWorker } from "../config/sessions/session-pending-input-receipts.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { IncognitoSessionSyncAccessError } from "./incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let sql: ReturnType<typeof observeHostDataSql>;
const receipts = new Set<SessionPendingInputReceipt>();

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-pending-input-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
beforeEach(() => {
  sql = observeHostDataSql();
});
afterEach(async () => {
  try {
    for (const receipt of receipts) {
      receipt.finish("interrupted");
    }
    await Promise.allSettled([...receipts].map(async (receipt) => receipt.settled?.()));
    receipts.clear();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function fixture(name: string) {
  const scope: PendingInputScope = {
    agentId: actor.agentId,
    env,
    sessionKey: `agent:main:dashboard:incognito-input-${name}`,
    sessionId: name,
    incognito: { actor, authority },
  };
  await actor.sessions.create(authority, {
    sessionKey: scope.sessionKey,
    entry: { sessionId: name, lifecycleRevision: "initial", incognito: true, updatedAt: 1 },
  });
  const history = createIncognitoPendingInputHistoryReader({
    actor,
    authority,
    target: { sessionKey: scope.sessionKey, sessionId: name, lifecycleRevision: "initial" },
  });
  return {
    scope,
    history,
    async stage(runId: string, trackCompletion = false, current = () => authority.assertCurrent()) {
      const receipt = await stageSessionPendingInput(scope, {
        runId,
        trackCompletion,
        assertCurrent: current,
        message: {
          role: "user",
          content: `Synthetic ${runId}`,
          timestamp: 1,
          idempotencyKey: `${runId}:user`,
        },
      });
      assert(receipt);
      receipts.add(receipt);
      return receipt;
    },
  };
}

it("captures the shared actor for staging, submitted input, history, receipts and terminal settlement", async () => {
  const f = await fixture("custody");
  f.scope.incognito = undefined;
  await withIncognitoSessionActor(actor, async () => {
    const first = await f.stage("first", true);
    const second = await f.stage("second");
    expect(
      (await listSessionPendingInputs(f.scope)).items.map(({ runId, state }) => ({ runId, state })),
    ).toEqual([
      { runId: "first", state: "queued" },
      { runId: "second", state: "queued" },
    ]);
    expect(await readSessionPendingInput(f.scope, second.inputId)).toMatchObject({
      runId: "second",
      state: "queued",
    });
    expect(
      await readSessionPendingInputReceiptsInWorker(f.scope, { runIds: ["first", "second"] }),
    ).toEqual([
      { runId: "first", state: "pending" },
      { runId: "second", state: "pending" },
    ]);
    await expect(
      readSessionPendingInputReceiptsInWorker(
        { ...f.scope, sessionId: "retired-custody" },
        { runIds: ["first"] },
      ),
    ).rejects.toThrow("session generation is no longer current");
    expect(await readSessionSubmittedInput(f.scope, "first:user")).toEqual(first.message);
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    expect(await first.completeAsync?.(outcome)).toEqual(outcome);
    first.finish("interrupted");
    second.finish("cancelled");
    await Promise.all([first.settled?.(), second.settled?.()]);
    expect(() => second.run(() => {})).toThrow("ownership ended");
    expect((await listSessionPendingInputs(f.scope)).items.map(({ state }) => state)).toEqual([
      "cancelled",
    ]);
    expect(await readSessionPendingInputReceiptsInWorker(f.scope, { runIds: ["second"] })).toEqual([
      { runId: "second", state: "pending", cancelled: true },
    ]);
    const replay = await f.stage("first", true);
    expect(replay.completion).toEqual(outcome);
  });
});

it.each(["transaction", "commit"] as const)(
  "rechecks live staging custody at %s without publishing rejected input",
  async (phase) => {
    const f = await fixture(`refusal-${phase}`);
    const refusal = new IncognitoSessionSyncAccessError("legacy", "legacyAsync");
    let refused = false;
    probe.admission(workerAdmission, (request, grant, callback) => {
      if (
        request.stage === phase &&
        isRecord(request.facts) &&
        isRecord(request.facts.pendingInput)
      ) {
        refused = true;
      }
      callback(request, grant);
    });
    await expect(
      f.stage(`refused-${phase}`, false, () => {
        if (refused) {
          throw refusal;
        }
      }),
    ).rejects.toBe(refusal);
    expect(refused).toBe(true);
    expect((await f.history.list()).items).toEqual([]);
  },
);

it("publishes one acknowledged stage when the ordinary reply is lost without replay", async () => {
  const f = await fixture("lost-reply");
  let executions = 0;
  const run = workerStore.runSqliteWorkerStoreOperation;
  vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
    <Operations extends SqliteWorkerOperations, T>(
      store: SqliteWorkerStore<Operations>,
      operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
      stateContext?: Parameters<typeof run>[2],
      assertCurrent?: Parameters<typeof run>[3],
      admission?: Parameters<typeof run>[4],
    ) =>
      run(
        store,
        (scope) =>
          operation({
            execute: async (command, options) => {
              const value = await scope.execute(command, options);
              if (command.type === "session.pendingInputs.mutate") {
                executions++;
                throw new Error("Synthetic committed reply loss");
              }
              return value;
            },
          }),
        stateContext,
        assertCurrent,
        admission,
      ),
  );
  const receipt = await f.stage("lost-reply");
  expect(executions).toBe(1);
  expect(receipt.run(() => "current")).toBe("current");
  expect((await f.history.list()).items).toMatchObject([{ runId: "lost-reply", state: "queued" }]);
  receipt.finish("cancelled");
  await receipt.settled?.();
  expect(executions).toBe(2);
});

it("rejects a binding to another physical actor before staging", async () => {
  const f = await fixture("wrong-source");
  f.scope.env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-pending-foreign-") };
  await expect(f.stage("foreign")).rejects.toThrow("differs from its captured incognito actor");
  expect((await f.history.list()).items).toEqual([]);
});

it("refuses pending execution after its captured actor reference is released", async () => {
  const f = await fixture("released-reference");
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: actor.agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  try {
    f.scope.incognito = { actor: borrowed, authority };
    const receipt = await f.stage("released-reference");
    await borrowed.release();
    const execute = vi.fn();
    expect(() => receipt.run(execute)).toThrow("Incognito execution reference is released");
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await borrowed.release();
  }
});

it("refuses submitted-input disclosure when its shared actor borrow is released after reading", async () => {
  const f = await fixture("submitted-release");
  await f.stage("submitted-release");
  f.scope.incognito = undefined;
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: actor.agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  const read = borrowed.sessions.readPendingInput.bind(borrowed.sessions);
  let releasing: Promise<void> | undefined;
  vi.spyOn(borrowed.sessions, "readPendingInput").mockImplementation(async (...args) => {
    const result = await read(...args);
    releasing = borrowed.release();
    return result;
  });
  const disclosed = vi.fn();
  try {
    await expect(
      withIncognitoSessionActor(borrowed, async () => {
        disclosed(await readSessionSubmittedInput(f.scope, "submitted-release:user"));
      }),
    ).rejects.toThrow("Incognito execution reference is released");
    expect(disclosed).not.toHaveBeenCalled();
  } finally {
    await releasing;
    await borrowed.release();
  }
});

it.each(["staged", "transcript-recovered"] as const)(
  "rechecks captured binding authority before %s pending execution",
  async (source) => {
    const f = await fixture(`revoked-binding-${source}`);
    let current = true;
    f.scope.incognito = {
      actor,
      authority: {
        assertCurrent() {
          if (!current) {
            throw new Error("Binding authority revoked");
          }
        },
      },
    };
    let committedId: string | undefined;
    if (source === "transcript-recovered") {
      const appended = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey: f.scope.sessionKey,
          sessionId: f.scope.sessionId,
          fence: { expectedLifecycleRevision: "initial" },
          message: {
            role: "user",
            content: "Synthetic revoked-binding",
            timestamp: 1,
            idempotencyKey: "revoked-binding:user",
          },
        },
      });
      assert(appended.ok && appended.value.append);
      committedId = appended.value.append.messageId;
    }
    const receipt = await f.stage("revoked-binding");
    if (source === "transcript-recovered") {
      expect(receipt.inputId).toBe(committedId);
    }
    const execute = vi.fn(() => "allowed");
    expect(receipt.run(execute)).toBe("allowed");
    execute.mockClear();
    current = false;
    try {
      expect(() => receipt.run(execute)).toThrow("Binding authority revoked");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      current = true;
    }
  },
);

it("propagates a completion refusal without silently dispatching a terminal write", async () => {
  const f = await fixture("completion-refusal");
  const receipt = await f.stage("completion-refusal", true);
  const failure = new IncognitoSessionSyncAccessError("legacyCompletion", "completeAsync");
  const mutate = actor.sessions.mutatePendingInput.bind(actor.sessions);
  const operations: string[] = [];
  vi.spyOn(actor.sessions, "mutatePendingInput").mockImplementation((...args) => {
    operations.push(args[1].kind);
    return args[1].kind === "complete" ? Promise.reject(failure) : mutate(...args);
  });
  await expect(
    receipt.completeAsync?.(buildAgentRunTerminalOutcome({ status: "ok" })),
  ).rejects.toBe(failure);
  receipt.finish("interrupted");
  await expect(receipt.settled?.()).rejects.toBe(failure);
  expect(operations).toEqual(["complete"]);
});
