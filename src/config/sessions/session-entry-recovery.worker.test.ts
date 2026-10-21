import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { test } from "./session-entry-fixture.test-support.js";
import {
  iteratePendingExecNotificationEntriesInWorker,
  readPendingInputRecoveryEntriesInWorker,
} from "./session-entry-read-maintenance.js";
import { readSessionEntrySummariesInWorker } from "./session-entry-read-runtime.js";
import { readSessionSendRecoveryPage } from "./session-pending-input-history.js";
import type { InternalSessionEntry } from "./types.js";

type InputScope = Parameters<typeof stageSessionPendingInput>[0];
type InputOptions = Parameters<typeof stageSessionPendingInput>[1];
function stageInput(
  scope: InputScope,
  runId: string,
  message: Partial<InputOptions["message"]> = {},
  trackCompletion = false,
) {
  return stageSessionPendingInput(scope, {
    runId,
    message: {
      role: "user",
      content: `Synthetic ${runId} input`,
      timestamp: 1,
      idempotencyKey: `${runId}:user`,
      __openclaw: { sessionSendDelivery: { version: 1 } },
      ...message,
    },
    assertCurrent() {},
    trackCompletion,
  }).then((receipt) => expectDefined(receipt, "Expected accepted input custody"));
}

function inputReceipts() {
  const receipts: SessionPendingInputReceipt[] = [];
  return Object.assign(receipts, {
    async [Symbol.asyncDispose]() {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    },
  });
}

async function finishInput(
  receipt: SessionPendingInputReceipt,
  state: "interrupted" | "cancelled" = "interrupted",
) {
  receipt.finish(state);
  await receipt.settled?.();
}

test("selects recovery claims and main-session startup orphans", async ({ store: { store } }) => {
  const { env } = store;
  const recovery = { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 };
  const runId = "interrupted-run";
  const runs = [{ runId, lifecycleGeneration: "previous-gateway" }];
  const terminalIds = { restartRecoveryTerminalRunIds: [runId] };
  const terminal = { restartRecoveryRuns: runs, ...terminalIds };
  const entries: Record<string, Partial<InternalSessionEntry>> = {
    archived: { archivedAt: 1, mainRestartRecovery: recovery },
    empty: { restartRecoveryRuns: [] },
    settled: { status: "done" },
    terminal,
    tombstoned: { mainRestartRecovery: { ...recovery, tombstone: { reason: "exhausted" } } },
    "pending-cycle": { abortedLastRun: true, mainRestartRecovery: recovery },
    "pending-delivery": { status: "done", restartRecoveryDeliveryRunId: "delivery-run" },
    "pending-execution": { status: "done", restartRecoveryRuns: runs },
    "pending-final": {
      status: "done",
      pendingFinalDelivery: { createdAt: 1, kind: "transport-only" },
    },
    "pending-residue": { status: "done", mainRestartRecovery: recovery, ...terminal },
    "orphan-aborted": { abortedLastRun: true },
    "orphan-interrupted": { status: "interrupted" },
    "settled-aborted": { abortedLastRun: false },
    "settled-interruption": {
      status: "interrupted",
      abortedLastRun: false,
      lastRunId: runId,
      ...terminalIds,
    },
    "archived-orphan": { archivedAt: 1, abortedLastRun: true },
    "subagent:orphan": { abortedLastRun: true },
    "cron:orphan": { abortedLastRun: true },
    "acp:orphan": { abortedLastRun: true },
    "spawned-orphan": { abortedLastRun: true, spawnDepth: 1 },
  };
  for (const [name, entry] of Object.entries(entries)) {
    replaceSessionEntrySync(
      { agentId: "main", env, sessionKey: `agent:main:${name}` },
      { sessionId: name, updatedAt: 1, ...entry },
    );
  }

  const keys = async (mainSessionRecovery?: "claims" | "orphans") =>
    (await readSessionEntrySummariesInWorker({ ...store, mainSessionRecovery })).map(
      ({ sessionKey }) => sessionKey,
    );
  const claims = ["cycle", "delivery", "execution", "final", "residue"].map(
    (suffix) => `agent:main:pending-${suffix}`,
  );
  expect(await keys("claims")).toEqual(claims);
  expect(await keys("orphans")).toEqual([
    "agent:main:orphan-aborted",
    "agent:main:orphan-interrupted",
    ...claims,
  ]);
  expect(await keys()).toHaveLength(Object.keys(entries).length);
});

test("pages exec owners without unrelated entries or saved prompts", async ({
  store: { database, store },
}) => {
  const { env } = store;
  const expected: string[] = [];
  for (let index = 0; index < 70; index += 1) {
    const sessionKey = `agent:main:exec-${String(index).padStart(2, "0")}`;
    expected.push(sessionKey);
    replaceSessionEntrySync(
      { agentId: "main", env, sessionKey },
      {
        sessionId: `exec-${index}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: "saved prompt".repeat(1024), skills: [] },
        pendingExecNotifications: {
          [`execution-${index}`]: {
            processSessionId: `process-${index}`,
            sessionId: `exec-${index}`,
            incarnation: "previous-gateway",
            startedAt: 1,
            label: "background exec",
            policy: {},
          },
        },
      },
    );
    writeSessionEntry(database, `agent:main:unrelated-${index}`, {
      sessionId: `unrelated-${index}`,
      updatedAt: 1,
    });
  }
  writeSessionEntry(database, "agent:main:empty-exec", {
    sessionId: "empty-exec",
    updatedAt: 1,
    pendingExecNotifications: {},
  });

  const selected = [];
  for await (const item of iteratePendingExecNotificationEntriesInWorker(store)) {
    selected.push(item);
  }
  expect(selected.map(({ sessionKey }) => sessionKey)).toEqual(expected);
  expect(selected.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(true);
  expect(
    selected.every(({ entry }) => Object.keys(entry.pendingExecNotifications ?? {}).length === 1),
  ).toBe(true);
});

test("pages saved deliveries while preserving live custody", async ({
  store: { database, store },
}) => {
  const scope = {
    ...store,
    sessionKey: "agent:main:mixed-recovery",
    sessionId: "mixed-recovery",
  };
  writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
  await using receipts = inputReceipts();
  for (let index = 0; index < 24; index++) {
    const receipt = await stageInput(scope, `input-${index}`, {
      content: `Synthetic input ${index}`,
      timestamp: index,
      ...(index === 22 ? { __openclaw: undefined } : {}),
    });
    receipts.push(receipt);
    if (index !== 21) {
      await finishInput(receipt, index === 23 ? "cancelled" : "interrupted");
    }
  }
  const newer = await readSessionSendRecoveryPage(scope);
  const older = await readSessionSendRecoveryPage(scope, { before: newer.nextBefore });
  expect(newer.items.map((item) => item.runId)).toEqual(
    Array.from({ length: 20 }, (_, index) => `input-${index + 2}`),
  );
  expect(older.items.map((item) => item.runId)).toEqual(["input-0", "input-1"]);
  expect(older.nextBefore).toBeUndefined();
  expect(newer.items.at(-1)?.state).toBe("queued");
  expect(newer.items.slice(0, -1).every((item) => item.state === "interrupted")).toBe(true);
});

test("reconciles interrupted and crash-left chat inputs at startup", async ({
  store: { database, store },
}) => {
  const scope = { ...store, sessionKey: "agent:main:chat-recovery", sessionId: "chat-recovery" };
  writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
  await using receipts = inputReceipts();
  for (const runId of ["terminated", "killed", "legacy"]) {
    const receipt = await stageInput(scope, runId, {
      content: `Saved ${runId} chat input`,
      __openclaw: runId === "legacy" ? undefined : { chatInputRecovery: { version: 1 } },
    });
    receipts.push(receipt);
    await finishInput(receipt);
    if (runId !== "terminated") {
      // Crash-left rows have no live receipt for lifecycle rotation to finish.
      database.db
        .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
        .run(receipt.inputId);
    }
  }
  rotateAgentEventLifecycleGeneration();
  expect(
    (await readPendingInputRecoveryEntriesInWorker(store)).map((row) => row.sessionKey),
  ).toEqual([scope.sessionKey]);
  // This is the startup owner's read, without a preceding chat.history request.
  const page = await readSessionSendRecoveryPage(scope);
  expect(page.items.map(({ runId, state }) => ({ runId, state }))).toEqual([
    { runId: "terminated", state: "interrupted" },
    { runId: "killed", state: "interrupted" },
    { runId: "legacy", state: "interrupted" },
  ]);
});

test("skips an admitted store without optional pending-input storage", async ({
  store: { database, store },
}) => {
  const { env } = store;
  writeSessionEntry(database, "agent:main:recovery-old-store", {
    sessionId: "old-store-session",
    updatedAt: 1,
  });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  copyFileSync(database.path, `${database.path}.previous`);
  renameSync(`${database.path}.previous`, database.path);
  {
    using previous = new DatabaseSync(database.path);
    previous.exec("DROP TABLE session_pending_inputs");
  }

  openOpenClawAgentDatabase({ agentId: "main", env });
  expect(await readPendingInputRecoveryEntriesInWorker(store)).toEqual([]);
});

test("refreshes empty recovery reads with only recoverable inputs", async ({
  store: { database, store },
}) => {
  const scope = (name: string) => ({
    ...store,
    sessionKey: `agent:main:recovery-${name}`,
    sessionId: `recovery-${name}`,
  });
  const states = [
    "empty",
    "queued",
    "interrupted",
    "cancelled",
    "completed",
    "consumed",
    "old",
    "ordinary",
  ];
  for (const name of states) {
    const target = scope(name);
    writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
  }
  await using receipts = inputReceipts();
  const stage = async (name: string, trackCompletion = false) => {
    const receipt = await stageInput(
      scope(name),
      name,
      name === "ordinary" ? { __openclaw: undefined } : {},
      trackCompletion,
    );
    receipts.push(receipt);
    return receipt;
  };

  expect(await readPendingInputRecoveryEntriesInWorker(store)).toEqual([]);
  await stage("queued");
  await finishInput(await stage("ordinary"));
  await finishInput(await stage("interrupted"));
  await finishInput(await stage("cancelled"), "cancelled");
  const completed = await stage("completed", true);
  await expectDefined(
    completed.completeAsync,
    "Expected completion owner",
  )(buildAgentRunTerminalOutcome({ status: "ok" }));
  await finishInput(completed);

  // Collected sources retain their queued row with a consumption receipt.
  const consumed = await stage("consumed");
  const aggregate = expectDefined(
    bindSessionPendingInputSources([consumed], {
      role: "user",
      content: "Synthetic collected input",
      timestamp: 2,
      idempotencyKey: "collected:user",
    }),
    "Expected collected input custody",
  );
  receipts.push(aggregate);
  await aggregate.run(() =>
    appendTranscriptMessage(scope("consumed"), { message: aggregate.message }),
  );
  expect(consumed.state).toBe("consumed");

  await finishInput(await stage("old"));
  writeSessionEntry(database, scope("old").sessionKey, {
    sessionId: "replacement-session",
    updatedAt: 2,
  });

  const candidates = await readPendingInputRecoveryEntriesInWorker(store);
  expect(
    candidates
      .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey))
      .map(({ sessionKey, entry }) => [sessionKey, entry.sessionId]),
  ).toEqual([
    ["agent:main:recovery-interrupted", "recovery-interrupted"],
    ["agent:main:recovery-queued", "recovery-queued"],
  ]);
});
