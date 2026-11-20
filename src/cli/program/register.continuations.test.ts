// karmaterminal/openclaw#1271, the fence drain. A build without the continue_work turn-start fence
// strips `turnStart` on decode and re-drives a fenced, undelivered wake, so before a seat starts one
// it must hold none: counted read-only on the stopped store, drained by the product itself. Real:
// the custody store and its worker, the claim and the fence writer, the session-delivery queue, the
// Gateway lock and offline state ownership, the read-only snapshot. Observed: the commands' output
// and exit codes, and the store's files and records.
import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContinuationCustodyProjection } from "../../auto-reply/continuation/custody/custody-projection.js";
import {
  createContinuationRecord,
  hydrateContinuationCustody,
  listContinuationRecords,
  newContinuationRecordId,
  requestContinuationRecordCancel,
} from "../../auto-reply/continuation/custody/custody-store.js";
import { encodeWorkState } from "../../auto-reply/continuation/work-flow-state.js";
import {
  consumePendingWork,
  interruptStartedWorkRecord,
  listPendingTerminalNoticeWork,
  listPendingWorkSessionKeysForRecovery,
  markPendingWorkDelivered,
  markPendingWorkTurnStarted,
} from "../../auto-reply/continuation/work-store.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadPendingSessionDeliveries } from "../../infra/session-delivery-queue-storage.js";
import { isContinuationSessionDelivery } from "../../infra/session-delivery-queue.records.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { useLocalStateOwnerFixture } from "../local-state-owner.fixture.test-support.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerContinuationsCommand } from "./register.continuations.js";

const world = vi.hoisted(() => ({
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  /** Decode as a build without the fence does. */
  preFenceCodec: false,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: world.runtime,
}));
// The pre-fence codec: an older build decodes the same state and drops `turnStart` (its schema
// strips unknown keys). Recovery's selection and claim are otherwise unchanged since the fence
// landed (2186878dee), so the current claim under this codec is the older build's claim.
vi.mock("../../auto-reply/continuation/work-flow-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auto-reply/continuation/work-flow-state.js")>();
  return {
    ...actual,
    decodeWorkState: (record: Parameters<typeof actual.decodeWorkState>[0]) => {
      const state = actual.decodeWorkState(record);
      if (!world.preFenceCodec || !state) {
        return state;
      }
      const { turnStart: _dropped, ...preFence } = state;
      return preFence;
    },
  };
});

const INTERRUPTED = "turn-started-delivery-unconfirmed";
const NOTICE_TAG = "[continuation:work-turn-interrupted]";
const RUNNING_RECOVERY_STALE_MS = 60_000;
const fixture = useLocalStateOwnerFixture();

beforeEach(async () => {
  world.runtime.log.mockReset();
  world.runtime.error.mockReset();
  world.runtime.exit.mockReset();
  world.preFenceCodec = false;
  await captureRuntimeConfigAsyncReader()();
  await hydrateContinuationCustody();
});
afterEach(async () => {
  vi.useRealTimers();
  resetContinuationCustodyProjection();
  clearRuntimeConfigSnapshot();
  await closeOpenClawStateDatabaseAsync();
});

/** The command's exit code (0 when it never called exit) and its JSON output. */
async function run(command: "fence-status" | "interrupt-fenced") {
  world.runtime.log.mockReset();
  world.runtime.exit.mockReset();
  const program = new OpenClawCommand().enablePositionalOptions();
  registerContinuationsCommand(program);
  await program.parseAsync(["continuations", command, "--json"], { from: "user" });
  const exitCode = world.runtime.exit.mock.calls[0]?.[0] ?? 0;
  return { exitCode, output: JSON.parse(String(world.runtime.log.mock.lastCall?.[0])) };
}

/** A due continue_work wake, queued as the election leaves it. */
async function dueWake(sessionKey: string): Promise<string> {
  const recordId = newContinuationRecordId();
  const now = Date.now();
  const state = { sessionKey, hop: 1, delayMs: 0, electedAt: now, dueAt: now, maxChainLength: 10 };
  await createContinuationRecord({
    recordId,
    kind: "work",
    ownerSessionKey: sessionKey,
    status: "queued",
    createdAt: now,
    dueAt: now,
    stateJson: JSON.stringify(encodeWorkState(state)),
  });
  return recordId;
}

/** A wake claimed and fenced by the real writers, whose Gateway then died before delivery. */
async function fencedWake(sessionKey: string) {
  const recordId = await dueWake(sessionKey);
  const [claimed] = await consumePendingWork(sessionKey);
  const runId = `run-${recordId}`;
  const fenced = await markPendingWorkTurnStarted(claimed!, runId);
  if (!fenced.allowed) {
    throw new Error(`fence refused: ${fenced.reason}`);
  }
  return { recordId, runId, work: fenced.work };
}

const readRecord = async (recordId: string) =>
  (await listContinuationRecords({ recordIds: [recordId] }))[0];

async function interruptedNoticeRows() {
  return (
    await loadPendingSessionDeliveries(captureOpenClawStateWorkerContext({ env: process.env }))
  ).flatMap((entry) =>
    entry.kind === "systemEvent" && entry.text.startsWith(NOTICE_TAG) ? [entry] : [],
  );
}

/** The stopped store: the state database and whichever of its sidecars exist, byte for byte. */
function storeFiles(): Record<string, string> {
  const database = path.join(process.env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite");
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].flatMap((suffix) =>
      fs.existsSync(database + suffix)
        ? [[suffix || "db", fs.readFileSync(database + suffix).toString("base64")]]
        : [],
    ),
  );
}

describe("openclaw continuations", () => {
  it("counts fenced, undelivered wakes read-only, drains them once with one notice each, and never runs a turn", async () => {
    const a = await fencedWake("agent:main:fence-a");
    const b = await fencedWake("agent:main:fence-b");
    // Interrupted by recovery, which crashed before handing off the notice: still owed.
    const owed = await fencedWake("agent:main:fence-owed");
    expect(await interruptStartedWorkRecord((await readRecord(owed.recordId))!)).toBeDefined();
    // Not counted, not drained: due and unfenced (recovery would claim and drive it), cancel-fenced
    // (no build drives it), and delivered (done).
    const untouched = [await dueWake("agent:main:fence-unfenced")];
    const cancelled = await fencedWake("agent:main:fence-cancelled");
    const current = (await readRecord(cancelled.recordId))!;
    await requestContinuationRecordCancel({
      ...current,
      expectedRevision: current.revision,
      now: 1,
    });
    const delivered = await fencedWake("agent:main:fence-delivered");
    expect(await markPendingWorkDelivered(delivered.work)).toMatchObject({ applied: true });
    untouched.push(cancelled.recordId, delivered.recordId);
    const untouchedBefore = await listContinuationRecords({ recordIds: untouched });
    // The Gateway is stopped: no process holds the store open.
    resetContinuationCustodyProjection();
    await closeOpenClawStateDatabaseAsync();
    const stopped = storeFiles();

    const counted = await run("fence-status");
    expect(counted.exitCode).toBe(0);
    expect(counted.output).toEqual({
      databasePath: expect.stringMatching(/state[/\\]openclaw\.sqlite$/),
      fencedUndelivered: 2,
      records: expect.arrayContaining([
        expect.objectContaining({ recordId: a.recordId, status: "running", runId: a.runId }),
        expect.objectContaining({ recordId: b.recordId, status: "running", runId: b.runId }),
      ]),
      owedInterruptNotices: 1,
      owedNoticeRecordIds: [owed.recordId],
    });
    // The count never writes: the store's bytes, and which sidecars exist, are unchanged.
    expect(storeFiles()).toEqual(stopped);

    const drained = await run("interrupt-fenced");
    expect(drained.exitCode).toBe(0);
    expect(drained.output).toMatchObject({ interrupted: 2, noticesSettled: 3 });
    for (const { recordId, runId } of [a, b, owed]) {
      const record = await readRecord(recordId);
      expect(record).toMatchObject({ status: "failed", failureReason: INTERRUPTED });
      expect(record?.terminalNoticePending).toBeUndefined();
      const rows = (await interruptedNoticeRows()).filter((row) => row.text.includes(recordId));
      // Exactly one notice row, named in the receipt, naming the record and its run.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toContain(runId);
      expect(drained.output.records).toContainEqual({
        recordId,
        ownerSessionKey: record?.ownerSessionKey,
        status: "failed",
        failureReason: INTERRUPTED,
        interruptedNow: recordId !== owed.recordId,
        noticeDeliveryId: rows[0]?.id,
        noticeDeliveryStatus: "pending",
      });
    }
    // Never a claim, so never a turn; excluded records are exactly as they were.
    expect(await listContinuationRecords({ recordIds: untouched })).toEqual(untouchedBefore);

    resetContinuationCustodyProjection();
    await closeOpenClawStateDatabaseAsync();
    expect((await run("fence-status")).output).toMatchObject({
      fencedUndelivered: 0,
      records: [],
      owedInterruptNotices: 0,
    });
    // Idempotent: a second drain changes nothing and reports nothing.
    const drainedRecords = await listContinuationRecords({});
    const drainedRows = await interruptedNoticeRows();
    expect(drainedRows).toHaveLength(3);
    resetContinuationCustodyProjection();
    await closeOpenClawStateDatabaseAsync();
    expect((await run("interrupt-fenced")).output).toMatchObject({
      interrupted: 0,
      noticesSettled: 0,
      records: [],
    });
    expect(await listContinuationRecords({})).toEqual(drainedRecords);
    expect(await interruptedNoticeRows()).toEqual(drainedRows);
  });

  it.each(["fence-status", "interrupt-fenced"] as const)(
    "%s fails by name, creating nothing, when the selected root has no state database",
    async (command) => {
      const emptyRoot = fixture.roots.make("openclaw-fence-wrong-root-");
      vi.stubEnv("OPENCLAW_STATE_DIR", emptyRoot);

      const failed = await run(command);
      expect(failed).toMatchObject({
        exitCode: 1,
        output: { ok: false, error: { code: "STATE_DATABASE_MISSING" } },
      });
      expect(fs.existsSync(path.join(emptyRoot, "state"))).toBe(false);
    },
  );

  it("counts a wake a crashed Gateway left only in the WAL, without touching the WAL", async () => {
    const { recordId } = await fencedWake("agent:main:fence-wal");
    // A Gateway killed before any checkpoint: its store family is copied while still open. The
    // control copies the main file alone, as a reader that skipped the WAL would see it.
    const database = path.join(process.env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite");
    const copyStore = (suffixes: readonly string[]) => {
      const stateDir = fixture.roots.make("openclaw-fence-crashed-");
      fs.mkdirSync(path.join(stateDir, "state"));
      for (const suffix of suffixes) {
        fs.copyFileSync(
          database + suffix,
          path.join(stateDir, "state", `openclaw.sqlite${suffix}`),
        );
      }
      return stateDir;
    };
    const crashedStateDir = copyStore(["", "-wal", "-shm"]);
    const mainFileOnly = copyStore([""]);
    resetContinuationCustodyProjection();
    await closeOpenClawStateDatabaseAsync();

    vi.stubEnv("OPENCLAW_STATE_DIR", mainFileOnly);
    expect((await run("fence-status")).output).toMatchObject({ fencedUndelivered: 0 });

    vi.stubEnv("OPENCLAW_STATE_DIR", crashedStateDir);
    const crashed = storeFiles();
    expect(Object.keys(crashed)).toEqual(["db", "-wal", "-shm"]);
    const counted = await run("fence-status");
    expect(counted).toMatchObject({
      exitCode: 0,
      output: { fencedUndelivered: 1, records: [expect.objectContaining({ recordId })] },
    });
    expect(storeFiles()).toEqual(crashed);
  });

  it.each(["fence-status", "interrupt-fenced"] as const)(
    "%s refuses beside a running Gateway, by name, and touches nothing",
    async (command) => {
      await fencedWake("agent:main:fence-owned");
      resetContinuationCustodyProjection();
      await closeOpenClawStateDatabaseAsync();
      await fixture.startOwner();
      const stored = storeFiles();

      const refused = await run(command);
      expect(refused.exitCode).toBe(2);
      expect(refused.output).toMatchObject({
        ok: false,
        error: {
          code: "OWNER_UNAVAILABLE",
          message: expect.stringMatching(/offline-only.*stop the Gateway/s),
        },
      });
      // Nothing read through a writer, nothing ended: the fenced record's bytes are as they were.
      expect(storeFiles()).toEqual(stored);
      expect(fixture.transport.request).not.toHaveBeenCalled();
    },
  );

  it("leaves a build without the fence nothing to re-drive and no notice to reword", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const kept = await fencedWake("agent:main:fence-undrained");
    vi.setSystemTime(Date.now() + RUNNING_RECOVERY_STALE_MS + 1);
    const preFenceRecovery = (sessionKey: string) =>
      consumePendingWork(sessionKey, {
        includeRunning: true,
        includeRunningUpdatedAtOrBefore: Date.now() - RUNNING_RECOVERY_STALE_MS,
        includeIdleRetry: true,
      });

    // The hazard: without the drain, a pre-fence boot claims the started wake to drive it again.
    world.preFenceCodec = true;
    expect(await listPendingWorkSessionKeysForRecovery()).toContain("agent:main:fence-undrained");
    expect((await preFenceRecovery("agent:main:fence-undrained")).map((w) => w.flowId)).toEqual([
      kept.recordId,
    ]);
    expect(await readRecord(kept.recordId)).toMatchObject({
      status: "running",
      phase: "Re-driving same-session continuation wake",
    });

    world.preFenceCodec = false;
    const drained = await fencedWake("agent:main:fence-drained");
    resetContinuationCustodyProjection();
    await closeOpenClawStateDatabaseAsync();
    const receipt = await run("interrupt-fenced");
    const after = await readRecord(drained.recordId);

    // The drained wake under the pre-fence codec: never selected, never claimed, unchanged.
    world.preFenceCodec = true;
    vi.setSystemTime(Date.now() + RUNNING_RECOVERY_STALE_MS + 1);
    expect(await listPendingWorkSessionKeysForRecovery()).not.toContain("agent:main:fence-drained");
    expect(await preFenceRecovery("agent:main:fence-drained")).toEqual([]);
    expect(await readRecord(drained.recordId)).toEqual(after);
    // Nothing is left owed for the older build to word as retry-exhausted: the notice is already a
    // queue row with its text, of the kind startup delivery recovery replays (unchanged since the
    // fence landed).
    expect(await listPendingTerminalNoticeWork()).toEqual([]);
    const row = (await interruptedNoticeRows()).find((entry) =>
      entry.text.includes(drained.recordId),
    );
    expect(row?.text).toContain(`started its turn as run ${drained.runId}`);
    expect(row && isContinuationSessionDelivery(row)).toBe(true);
    expect(after).toMatchObject({ status: "failed", failureReason: INTERRUPTED });
    expect(receipt.output).toMatchObject({
      interrupted: 1,
      records: [expect.objectContaining({ recordId: drained.recordId, noticeDeliveryId: row?.id })],
    });
  });
});
