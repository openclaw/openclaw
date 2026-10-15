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
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { readPendingInputRecoveryEntriesInWorker } from "./session-entry-read-maintenance.js";

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
