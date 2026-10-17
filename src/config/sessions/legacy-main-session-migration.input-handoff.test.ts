import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { createLegacyMainSessionHandoff } from "./legacy-main-session-migration.handoff-fixture.test-support.js";
import {
  readClaim,
  recordHarnessDeletions,
  setupLegacyMainSessionMigrationTests,
  type ClaimTarget,
} from "./legacy-main-session-migration.test-support.js";
import { appendTranscriptMessage } from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import { readSessionPendingInputReceiptsInWorker as listSessionPendingInputReceipts } from "./session-pending-input-receipts.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();
const completed = buildAgentRunTerminalOutcome({ status: "ok" });
const stopped = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });
const interrupted = buildAgentRunTerminalOutcome({ status: "timeout", stopReason: "restart" });
const failed = buildAgentRunTerminalOutcome({ status: "error", error: "Retryable failure" });

function createInputHandoff(sharedStore = false) {
  const storePath = sharedStore
    ? path.join(tempDirs.make("legacy-input-shared-"), "sessions.sqlite")
    : undefined;
  const fixture = createFixture({
    agents: { entries: { ops: {} } },
    ...(storePath ? { session: { store: storePath } } : {}),
  });
  const handoff = createLegacyMainSessionHandoff(fixture, "input-handoff-generation", storePath);
  const { scope, withDatabase } = handoff;
  const rows = (target: ClaimTarget) =>
    withDatabase(target, ({ db }) => {
      const read = (table: string, order: string) =>
        db
          .prepare(`SELECT * FROM ${table} WHERE session_key = ? ORDER BY ${order}`)
          .all(target.key);
      return {
        pending: read("session_pending_inputs", "seq").map(({ seq: _seq, ...row }) => row),
        completions: read("session_input_completions", "idempotency_key"),
      };
    });
  const accept = async (
    target: ClaimTarget,
    runId: string,
    params: {
      completion?: AgentRunTerminalOutcome;
      disposition?: "interrupted" | "cancelled";
      collected?: boolean;
    } = {},
  ) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(target), {
        runId,
        trackCompletion: true,
        assertCurrent: () => {},
        message: {
          role: "user",
          content: `Accepted input ${runId}: café 🦞`,
          timestamp: 1,
          idempotencyKey: `${runId}:user`,
        },
      }),
    );
    try {
      if (params.collected) {
        const aggregate = expectDefined(
          bindSessionPendingInputSources([receipt], {
            ...receipt.message,
            idempotencyKey: `${runId}:collected`,
          }),
        );
        const message = aggregate.message;
        const result = await aggregate.run(() =>
          appendTranscriptMessage(scope(target), { message }),
        );
        expect(result).toMatchObject({ appended: true, messageId: aggregate.inputId });
      }
      if (params.completion) {
        await receipt.completeAsync!(params.completion);
      }
    } finally {
      receipt.finish(params.disposition ?? "interrupted");
      await receipt.settled?.();
    }
    return receipt;
  };
  const setCompletedAt = (target: ClaimTarget, completedAt: number) =>
    withDatabase(target, ({ db }) => {
      const sql = "UPDATE session_input_completions SET completed_at = ? WHERE session_key = ?";
      db.prepare(sql).run(completedAt, target.key);
    });
  return { ...handoff, rows, accept, setCompletedAt };
}

describe("legacy main session input handoff", () => {
  it.each([false, true])(
    "preserves accepted and consumed inputs (shared: %s)",
    async (sharedStore) => {
      const f = createInputHandoff(sharedStore);
      const queued = await f.accept(f.source, "queued");
      const cancelled = await f.accept(f.source, "cancelled", { disposition: "cancelled" });
      const consumed = await f.accept(f.source, "consumed", { collected: true });
      // A crash can leave the persisted row queued after its process-local owner has disappeared.
      f.withDatabase(f.source, ({ db }) => {
        db.prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?").run(
          queued.inputId,
        );
      });
      const before = f.rows(f.source);
      const consumedByEventId = before.pending[2]!.consumed_event_id;
      expect(consumedByEventId).toEqual(expect.any(String));

      expect(await f.migrate()).toMatchObject({ complete: true });

      expect(readClaim(f.source)).toBeUndefined();
      expect(f.rows(f.destination)).toEqual({
        pending: before.pending.map((row) =>
          Object.assign({}, row, {
            session_key: f.destination.key,
            state: row.input_id === cancelled.inputId ? "cancelled" : "interrupted",
          }),
        ),
        completions: [],
      });
      expect(await listSessionPendingInputs(f.scope(f.destination))).toMatchObject({
        total: 2,
        items: [
          { id: queued.inputId, message: queued.message, state: "interrupted" },
          { id: cancelled.inputId, message: cancelled.message, state: "cancelled" },
        ],
      });
      expect(
        await listSessionPendingInputReceipts(f.scope(f.destination), { runIds: ["consumed"] }),
      ).toEqual([{ runId: "consumed", state: "consumed", consumedByEventId }]);
      expect(await f.accept(f.destination, "consumed")).toMatchObject({
        state: "consumed",
        inputId: consumed.inputId,
        message: consumed.message,
      });
      expect(() => queued.run(() => "stale work")).toThrow("ownership ended");
    },
  );

  it.each([
    ["operator Stop in-place", stopped, undefined, true, false, true],
    ["final destination", completed, stopped, true, true],
    ["final source over retryable destination", stopped, interrupted, true, false],
    ["newer retryable source", failed, interrupted, false, false],
    ["newer retryable destination", interrupted, failed, false, true],
  ] as const)(
    "preserves %s completion semantics",
    async (_name, source, destination, final, retainDestination, sharedStore = false) => {
      const f = createInputHandoff(sharedStore);
      await f.accept(f.source, "private-result", { completion: source });
      f.setCompletedAt(f.source, retainDestination ? 100 : 200);
      if (destination) {
        f.seed(f.destination);
        await f.accept(f.destination, "private-result", { completion: destination });
        f.setCompletedAt(f.destination, retainDestination ? 200 : 100);
      }
      const retained = f.rows(retainDestination ? f.destination : f.source).completions;
      expect(retained).toHaveLength(1);

      expect(await f.migrate()).toMatchObject({ complete: true });

      expect(readClaim(f.source)).toBeUndefined();
      expect(f.rows(f.destination).completions).toEqual(
        retained.map((row) => Object.assign({}, row, { session_key: f.destination.key })),
      );
      const retry = await f.accept(f.destination, "private-result");
      expect(retry.completion).toEqual(
        final ? (retainDestination ? destination : source) : undefined,
      );
      if (final) {
        expect(() => retry.run(() => "replayed work")).toThrow("already completed");
      }
    },
  );

  it.each(["pending input", "completion"] as const)(
    "retains source evidence on %s deletion races",
    async (kind) => {
      const f = createInputHandoff();
      await f.accept(f.source, "accepted", { completion: interrupted });
      const before = readClaim(f.source);
      let changed: ReturnType<typeof f.rows> | undefined;

      const { result, committed } = await recordHarnessDeletions(f.migrate, async () => {
        if (changed) {
          return;
        }
        await f.accept(
          f.source,
          kind === "pending input" ? "late-input" : "accepted",
          kind === "completion" ? { completion: failed } : {},
        );
        changed = f.rows(f.source);
      });

      expect(result.complete).toBe(false);
      expect(committed).toEqual([]);
      expect(readClaim(f.source)).toEqual(before);
      expect(f.rows(f.source)).toEqual(changed);
    },
  );
});
