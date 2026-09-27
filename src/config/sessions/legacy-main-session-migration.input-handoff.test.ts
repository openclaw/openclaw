import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  readClaim,
  recordHarnessDeletions,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
  type ClaimTarget,
} from "./legacy-main-session-migration.test-support.js";
import { appendTranscriptMessage } from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputReceipts,
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();
const completed = buildAgentRunTerminalOutcome({ status: "ok" });
const stopped = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });
const interrupted = buildAgentRunTerminalOutcome({ status: "timeout", stopReason: "restart" });
const failed = buildAgentRunTerminalOutcome({
  status: "error",
  error: "Synthetic retryable failure",
});

function createInputHandoff(sharedStore = false) {
  const storePath = sharedStore
    ? path.join(tempDirs.make("legacy-input-shared-"), "sessions.sqlite")
    : undefined;
  const fixture = createFixture({
    agents: { entries: { ops: {} } },
    ...(storePath ? { session: { store: storePath } } : {}),
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
  const entry = { sessionId: "input-handoff-generation", updatedAt: 100 };
  const events = [
    { type: "session", version: 3, id: entry.sessionId, timestamp: new Date(1).toISOString() },
  ];
  const source: ClaimTarget = {
    databaseAgentId: "main",
    databasePath: storePath ?? databasePath(fixture.stateDir, "main"),
    key: "agent:main:chat",
  };
  const destination: ClaimTarget = {
    databaseAgentId: sharedStore ? "main" : "ops",
    databasePath: storePath ?? databasePath(fixture.stateDir, "ops"),
    key: "agent:ops:chat",
  };
  seedClaim({ ...source, entry, events });
  const scope = (target: ClaimTarget) => ({
    agentId: target.key === source.key ? "main" : "ops",
    env: fixture.env,
    storePath: target.databasePath,
    sessionKey: target.key,
    sessionId: entry.sessionId,
  });
  const options = (target: ClaimTarget) => ({
    agentId: target.databaseAgentId,
    env: fixture.env,
    path: target.databasePath,
  });
  const rows = (target: ClaimTarget) =>
    runOpenClawAgentWriteTransaction(
      ({ db }) => ({
        pending: db
          .prepare("SELECT * FROM session_pending_inputs WHERE session_key = ? ORDER BY seq")
          .all(target.key)
          .map(({ seq: _seq, ...row }) => row),
        completions: db
          .prepare(
            "SELECT * FROM session_input_completions WHERE session_key = ? ORDER BY idempotency_key",
          )
          .all(target.key),
      }),
      options(target),
    );
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
      "Expected accepted input custody",
    );
    try {
      if (params.collected) {
        const aggregate = expectDefined(
          bindSessionPendingInputSources([receipt], {
            ...receipt.message,
            idempotencyKey: `${runId}:collected`,
          }),
          "Expected collected input custody",
        );
        expect(
          await aggregate.run(() =>
            appendTranscriptMessage(scope(target), { message: aggregate.message }),
          ),
        ).toMatchObject({ appended: true, messageId: aggregate.inputId });
      }
      if (params.completion) {
        receipt.complete!(params.completion);
      }
    } finally {
      receipt.finish(params.disposition ?? "interrupted");
    }
    return receipt;
  };
  const setCompletedAt = (target: ClaimTarget, completedAt: number) =>
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare("UPDATE session_input_completions SET completed_at = ? WHERE session_key = ?").run(
        completedAt,
        target.key,
      );
    }, options(target));
  const migrate = () =>
    migrateLegacyMainSessionKeys({ cfg: fixture.cfg, env: fixture.env, mode: "doctor-fix" });
  return {
    source,
    destination,
    entry,
    events,
    scope,
    options,
    rows,
    accept,
    setCompletedAt,
    migrate,
  };
}

describe("legacy main session input handoff", () => {
  it.each([
    { name: "cross-store", sharedStore: false },
    { name: "in-place", sharedStore: true },
  ])("preserves accepted and consumed inputs through $name migration", async ({ sharedStore }) => {
    const f = createInputHandoff(sharedStore);
    const queued = await f.accept(f.source, "queued");
    const cancelled = await f.accept(f.source, "cancelled", { disposition: "cancelled" });
    const consumed = await f.accept(f.source, "consumed", { collected: true });
    // A crash can leave the persisted row queued after its process-local owner has disappeared.
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?").run(
        queued.inputId,
      );
    }, f.options(f.source));
    const before = f.rows(f.source);
    expect(before.pending).toHaveLength(3);
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
    expect(listSessionPendingInputs(f.scope(f.destination))).toMatchObject({
      total: 2,
      items: [
        { id: queued.inputId, message: queued.message, state: "interrupted" },
        { id: cancelled.inputId, message: cancelled.message, state: "cancelled" },
      ],
    });
    expect(
      listSessionPendingInputReceipts(f.scope(f.destination), { runIds: ["consumed"] }),
    ).toEqual([{ runId: "consumed", state: "consumed", consumedByEventId }]);
    expect(await f.accept(f.destination, "consumed")).toMatchObject({
      state: "consumed",
      inputId: consumed.inputId,
      message: consumed.message,
    });
    expect(() => queued.run(() => "stale work")).toThrow("ownership ended");
  });

  it.each([
    { name: "completed source", source: completed, final: true },
    { name: "operator Stop in-place", source: stopped, final: true, sharedStore: true },
    { name: "restart interruption", source: interrupted, final: false },
    {
      name: "final destination",
      source: completed,
      destination: stopped,
      final: true,
      retainDestination: true,
    },
    {
      name: "final source over retryable destination",
      source: stopped,
      destination: interrupted,
      final: true,
    },
    { name: "newer retryable source", source: failed, destination: interrupted, final: false },
    {
      name: "newer retryable destination",
      source: interrupted,
      destination: failed,
      final: false,
      retainDestination: true,
    },
  ])("preserves $name completion semantics", async (scenario) => {
    const f = createInputHandoff(scenario.sharedStore);
    await f.accept(f.source, "private-result", { completion: scenario.source });
    f.setCompletedAt(f.source, scenario.retainDestination ? 100 : 200);
    if (scenario.destination) {
      seedClaim({ ...f.destination, entry: f.entry, events: f.events });
      await f.accept(f.destination, "private-result", { completion: scenario.destination });
      f.setCompletedAt(f.destination, scenario.retainDestination ? 200 : 100);
    }
    const retained = f.rows(scenario.retainDestination ? f.destination : f.source).completions;
    expect(retained).toHaveLength(1);

    expect(await f.migrate()).toMatchObject({ complete: true });

    expect(readClaim(f.source)).toBeUndefined();
    expect(f.rows(f.destination).completions).toEqual(
      retained.map((row) => Object.assign({}, row, { session_key: f.destination.key })),
    );
    const retry = await f.accept(f.destination, "private-result");
    expect(retry.completion).toEqual(
      scenario.final
        ? scenario.retainDestination
          ? scenario.destination
          : scenario.source
        : undefined,
    );
    if (scenario.final) {
      expect(() => retry.run(() => "replayed work")).toThrow("already completed");
    }
  });

  it.each(["pending input", "completion"] as const)(
    "retains source evidence when a %s changes during deletion preparation",
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

      expect(changed).toBeDefined();
      expect(result.complete).toBe(false);
      expect(committed).toEqual([]);
      expect(readClaim(f.source)).toEqual(before);
      expect(f.rows(f.source)).toEqual(changed);
    },
  );
});
