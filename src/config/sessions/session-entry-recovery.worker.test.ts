import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import {
  iteratePendingExecNotificationEntriesInWorker,
  readPendingInputRecoveryEntriesInWorker,
} from "./session-entry-read-maintenance.js";
import { readSessionEntrySummariesInWorker } from "./session-entry-read-runtime.js";
import { readSessionSendRecoveryPage } from "./session-pending-input-history.js";
import type { InternalSessionEntry } from "./types.js";

it("selects recovery custody and startup orphans without settled or non-main sessions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const recovery = { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 };
    const runs = [{ runId: "interrupted-run", lifecycleGeneration: "previous-gateway" }];
    const entries: Record<string, Partial<InternalSessionEntry>> = {
      archived: { archivedAt: 1, mainRestartRecovery: recovery },
      empty: { restartRecoveryRuns: [] },
      settled: { status: "done" },
      terminal: { restartRecoveryRuns: runs, restartRecoveryTerminalRunIds: ["interrupted-run"] },
      tombstoned: { mainRestartRecovery: { ...recovery, tombstone: { reason: "exhausted" } } },
      "pending-cycle": { abortedLastRun: true, mainRestartRecovery: recovery },
      "pending-delivery": { status: "done", restartRecoveryDeliveryRunId: "delivery-run" },
      "pending-execution": { status: "done", restartRecoveryRuns: runs },
      "pending-final": {
        status: "done",
        pendingFinalDelivery: { createdAt: 1, kind: "transport-only" },
      },
      "pending-residue": {
        status: "done",
        mainRestartRecovery: recovery,
        restartRecoveryRuns: runs,
        restartRecoveryTerminalRunIds: ["interrupted-run"],
      },
      "orphan-aborted": { abortedLastRun: true },
      "orphan-interrupted": { status: "interrupted" },
      "settled-aborted": { abortedLastRun: false },
      "settled-interruption": {
        status: "interrupted",
        abortedLastRun: false,
        lastRunId: "interrupted-run",
        restartRecoveryTerminalRunIds: ["interrupted-run"],
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

    const selected = await readSessionEntrySummariesInWorker({
      agentId: "main",
      storePath: database.path,
      env,
      mainSessionRecovery: "claims",
    });
    expect(selected.map(({ sessionKey }) => sessionKey)).toEqual([
      "agent:main:pending-cycle",
      "agent:main:pending-delivery",
      "agent:main:pending-execution",
      "agent:main:pending-final",
      "agent:main:pending-residue",
    ]);
    const orphans = await readSessionEntrySummariesInWorker({
      agentId: "main",
      storePath: database.path,
      env,
      mainSessionRecovery: "orphans",
    });
    expect(orphans.map(({ sessionKey }) => sessionKey)).toEqual([
      "agent:main:orphan-aborted",
      "agent:main:orphan-interrupted",
      "agent:main:pending-cycle",
      "agent:main:pending-delivery",
      "agent:main:pending-execution",
      "agent:main:pending-final",
      "agent:main:pending-residue",
    ]);
    expect(
      await readSessionEntrySummariesInWorker({ agentId: "main", storePath: database.path, env }),
    ).toHaveLength(Object.keys(entries).length);
  });
});

it("pages only pending exec owners without reading unrelated session entries or saved prompts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
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
    for await (const item of iteratePendingExecNotificationEntriesInWorker({
      agentId: "main",
      storePath: database.path,
      env,
    })) {
      selected.push(item);
    }
    expect(selected.map(({ sessionKey }) => sessionKey)).toEqual(expected);
    expect(selected.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(true);
    expect(
      selected.every(({ entry }) => Object.keys(entry.pendingExecNotifications ?? {}).length === 1),
    ).toBe(true);
  });
});

it("pages saved deliveries without unrelated or cancelled inputs and preserves live custody", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      storePath: database.path,
      env,
      sessionKey: "agent:main:mixed-recovery",
      sessionId: "mixed-recovery",
    };
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const receipts: SessionPendingInputReceipt[] = [];
    try {
      for (let index = 0; index < 24; index++) {
        const receipt = expectDefined(
          await stageSessionPendingInput(scope, {
            runId: `input-${index}`,
            message: {
              role: "user",
              content: `Synthetic input ${index}`,
              timestamp: index,
              idempotencyKey: `input-${index}:user`,
              ...(index === 22 ? {} : { __openclaw: { sessionSendDelivery: { version: 1 } } }),
            },
            assertCurrent() {},
          }),
          "Expected pending input custody",
        );
        receipts.push(receipt);
        if (index !== 21) {
          receipt.finish(index === 23 ? "cancelled" : "interrupted");
          await receipt.settled?.();
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
    } finally {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
});

it("skips an admitted store without optional pending-input storage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const store = { agentId: "main", storePath: database.path, env };
    writeSessionEntry(database, "agent:main:recovery-old-store", {
      sessionId: "old-store-session",
      updatedAt: 1,
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    copyFileSync(database.path, `${database.path}.previous`);
    renameSync(`${database.path}.previous`, database.path);
    const previous = new DatabaseSync(database.path);
    try {
      previous.exec("DROP TABLE session_pending_inputs");
    } finally {
      previous.close();
    }

    openOpenClawAgentDatabase({ agentId: "main", env });
    expect(await readPendingInputRecoveryEntriesInWorker(store)).toEqual([]);
  });
});

it("discovers only current recoverable inputs and observes writes after an empty recovery read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const store = { agentId: "main", storePath: database.path, env };
    const scope = (name: string) => ({
      ...store,
      sessionKey: `agent:main:recovery-${name}`,
      sessionId: `recovery-${name}`,
    });
    for (const name of [
      "empty",
      "queued",
      "interrupted",
      "cancelled",
      "completed",
      "consumed",
      "old",
      "ordinary",
    ]) {
      const target = scope(name);
      writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
    }
    const receipts: SessionPendingInputReceipt[] = [];
    const stage = async (name: string, trackCompletion = false) => {
      const receipt = expectDefined(
        await stageSessionPendingInput(scope(name), {
          runId: name,
          message: {
            role: "user",
            content: `Synthetic ${name} input`,
            timestamp: 1,
            idempotencyKey: `${name}:user`,
            ...(name === "ordinary" ? {} : { __openclaw: { sessionSendDelivery: { version: 1 } } }),
          },
          trackCompletion,
          assertCurrent() {},
        }),
        "Expected accepted input custody",
      );
      receipts.push(receipt);
      return receipt;
    };

    try {
      expect(await readPendingInputRecoveryEntriesInWorker(store)).toEqual([]);
      await stage("queued");
      const ordinary = await stage("ordinary");
      ordinary.finish("interrupted");
      await ordinary.settled?.();
      const interrupted = await stage("interrupted");
      interrupted.finish("interrupted");
      await interrupted.settled?.();
      const cancelled = await stage("cancelled");
      cancelled.finish("cancelled");
      await cancelled.settled?.();
      const completed = await stage("completed", true);
      await expectDefined(
        completed.completeAsync,
        "Expected completion owner",
      )(buildAgentRunTerminalOutcome({ status: "ok" }));
      completed.finish("interrupted");
      await completed.settled?.();

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

      const old = await stage("old");
      old.finish("interrupted");
      await old.settled?.();
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
    } finally {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
});
