import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as stateDb from "../state/openclaw-state-db.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { createManagedHandoffRecoveryFixture } from "./update-managed-service-handoff-recovery.test-support.js";
import * as ledger from "./update-run-ledger.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await stateDb.closeOpenClawStateDatabaseAsync();
    stateDb.closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
let fixture: ReturnType<typeof createManagedHandoffRecoveryFixture>;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const root = fs.realpathSync(dirs.make("managed-handoff-lease-repair-"));
  fixture = createManagedHandoffRecoveryFixture(root);
  env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
});
afterEach(() => vi.restoreAllMocks());

const newRun = (origin?: Parameters<typeof ledger.createUpdateRun>[0]["origin"]) =>
  ledger.createUpdateRun({ trigger: "cli", ...(origin && { origin }) }, { env });
const readRun = (runId: string) => ledger.getUpdateRun(runId, { env });
const nextUpdate = (store = fixture.store) =>
  store.acquire(fixture.root, "next-update", { kind: "update" }).kind;
const settlement = (runId: string) =>
  readRun(runId)?.steps.find((step) => step.step === "finalize:handoff-settlement");
async function prepareRepair(store = fixture.store, overrides = env) {
  const repair = await store.prepareRepair(fixture.root, overrides);
  if (!repair) {
    throw new Error("Expected an explicit handoff repair claim");
  }
  return repair;
}
async function withRepair(action: (repair: Awaited<ReturnType<typeof prepareRepair>>) => void) {
  using repair = await prepareRepair();
  action(repair);
}

it("records the settlement receipt before releasing a dead legacy lease and admits the next update", async () => {
  fixture.seed();
  let receiptAtRelease: unknown;
  const release = fixture.store.release;
  vi.spyOn(fixture.store, "release").mockImplementation((lease) => {
    receiptAtRelease = settlement(run.runId);
    return release(lease);
  });
  using repair = await prepareRepair();
  const run = newRun();
  expect(() => repair.complete(run.runId)).toThrow("requires its bound repair run");
  repair.bindRun(run.runId);

  repair.complete(run.runId);

  expect(receiptAtRelease).toMatchObject({
    status: "completed",
    endedAtMs: expect.any(Number),
    detail: expect.stringContaining("legacy handoff lease reclaimed"),
  });
  expect(fixture.store.read(fixture.root)).toEqual({ kind: "absent" });
  expect(nextUpdate()).toBe("acquired");
  ledger.finishUpdateRun(run.runId, { status: "succeeded" }, { env });
  expect(readRun(run.runId)?.steps).toContainEqual(receiptAtRelease);
});

it.each([
  "live descendant",
  "unverified descendant",
  "live owner",
  "unverified owner",
  "45-minute floor",
  "larger recorded timeout",
] as const)("preserves the retained generation for %s", async (reason) => {
  const largerTimeout = reason === "larger recorded timeout";
  const grace = largerTimeout || reason === "45-minute floor";
  const ageMs = (largerTimeout ? 46 : 44) * 60_000;
  const timeoutMs = largerTimeout ? 90 * 60_000 : undefined;
  const previous = fixture.seed(grace ? { ageMs, timeoutMs } : {});
  const { births, helper, processCensus } = fixture;
  let expected: string | RegExp | Error;
  if (grace) {
    expected = new Date(previous.updatedAt + (largerTimeout ? 90 : 45) * 60_000).toISOString();
  } else if (reason.endsWith("owner")) {
    births.set(helper.pid, reason === "live owner" ? Number(helper.startIdentity) : null);
    expected = new RegExp("live or unverified: PID " + helper.pid);
  } else if (reason === "unverified descendant") {
    processCensus.unverifiedPids.push(81234);
    processCensus.error = "Retry update repair as Administrator using the same Windows account.";
    expected = new Error(
      `Handoff descendants remain alive or unverified: PID 81234. ${processCensus.error}`,
    );
  } else {
    processCensus.matchingPids.push(81234);
    expected = /PID 81234.*openclaw update repair/;
  }
  await expect(prepareRepair()).rejects.toThrow(expected);
  expect(fixture.current()).toEqual(previous);
  if (reason === "live descendant") {
    expect(nextUpdate()).toBe("busy");
    expect(ledger.listUpdateRuns({}, { env })).toEqual([]);
  }
});

it("preserves an incomplete rollback across repair state overrides", async () => {
  const previous = fixture.seed();
  fixture.repairFacts.mockRestore();
  vi.spyOn(os, "tmpdir").mockReturnValue(fixture.root);
  const run = newRun({ driver: { ...previous.executor, host: os.hostname() } });
  ledger.recordUpdateRunStep(run.runId, { step: "package rollback", status: "completed" }, { env });
  ledger.finishUpdateRun(
    run.runId,
    { status: "failed", reason: "interrupted-restoration" },
    { env },
  );
  const recorded = readRun(run.runId);

  await expect(prepareRepair()).rejects.toThrow(/rollback.*update status/u);

  const directory = path.join(fixture.root, "openclaw-update-run-handoff-original-profile");
  fs.mkdirSync(directory, { mode: 0o700 });
  const handoff = {
    updateLeaseOwner: previous.owner,
    updateLeaseKey: previous.key,
    runId: run.runId,
    cwd: fixture.root,
  };
  fs.writeFileSync(path.join(directory, "handoff.json"), JSON.stringify(handoff), { mode: 0o600 });
  const otherProfile = { ...env, OPENCLAW_STATE_DIR: path.join(fixture.root, "other-state") };
  await expect(prepareRepair(fixture.store, otherProfile)).rejects.toThrow(
    "original profile and state overrides",
  );

  expect(fixture.current()).toEqual(previous);
  expect(readRun(run.runId)).toEqual(recorded);
});

it("refuses a changed generation after awaited artifact inspection", async () => {
  const previous = fixture.seed();
  const inspecting = createDeferred();
  const observation = createDeferred<typeof fixture.facts>();
  fixture.repairFacts.mockImplementationOnce(() => {
    inspecting.resolve();
    return observation.promise;
  });
  const result = prepareRepair();
  await inspecting.promise;
  const changed = fixture.replaceHeartbeat(previous);
  observation.resolve(fixture.facts);
  await expect(result).rejects.toThrow("ownership changed; retry");
  expect(fixture.current()).toEqual(changed);
});

it.each(["installation repair", "settlement receipt"] as const)(
  "retains uncertain recovery facts and artifacts after failed %s",
  async (failure) => {
    const previous = fixture.seed();
    const diagnostics = fs.readFileSync(fixture.diagnosticPath);
    const run = failure === "settlement receipt" ? newRun() : undefined;
    await expect(
      withRepair((repair) => {
        if (run) {
          repair.bindRun(run.runId);
          ledger.finishUpdateRun(run.runId, { status: "failed" }, { env });
          repair.complete(run.runId);
        } else {
          throw new Error("Current installation repair failed");
        }
      }),
    ).rejects.toThrow(run ? "settlement was not recorded" : "Current installation repair failed");
    const retained = fixture.current();
    expect(retained.owner).not.toBe(previous.owner);
    expect(retained).toMatchObject({
      helper: { pid: process.pid },
      action: { kind: "triage", phase: "uncertain" },
    });
    expect(fixture.readMetadata(retained)).toMatchObject({
      source: {
        owner: previous.owner,
        payload_json: previous.payload,
        updated_at: previous.updatedAt,
      },
      facts: { ...fixture.facts, runIds: ["retained-update", ...(run ? [run.runId] : [])] },
    });
    expect(fs.readFileSync(fixture.diagnosticPath)).toEqual(diagnostics);
    if (run) {
      expect(
        readRun(run.runId)?.steps.some((step) => step.step === "finalize:handoff-settlement"),
      ).toBe(false);
    } else {
      const olderWriterGeneration = fixture.replaceHeartbeat(retained);
      expect(fixture.readMetadata(olderWriterGeneration)).toBeNull();
      expect(nextUpdate()).toBe("busy");
      expect(ledger.listUpdateRuns({}, { env })).toEqual([]);
    }
  },
);

it("preserves interrupted repair evidence across reboot until explicit repair settles it", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const original = fixture.seed();
  const interruptedRun = newRun();
  await withRepair((repair) => repair.bindRun(interruptedRun.runId));
  expect(fixture.readMetadata(fixture.current())).toMatchObject({
    version: 3,
    source: { owner: original.owner, payload_json: original.payload },
    facts: { runIds: ["retained-update", interruptedRun.runId] },
  });
  now += 45 * 60_000 + 1_000;
  fixture.births.set(process.pid, 20);
  const boot = fixture.store.bootIdentity();
  vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
    ...boot,
    identity:
      boot.platform === "win32"
        ? "2026-09-16T03:42:10.5000000Z"
        : "01234567-89ab-cdef-0123-456789abcdee",
  }));
  const nextStore = createManagedHandoffLeaseStore();
  const retained = fixture.current();
  const metadata = fixture.readMetadata(retained);
  expect(nextUpdate(nextStore)).toBe("busy");
  expect(nextStore.release(retained)).toBe(false);
  expect(fixture.current()).toEqual(retained);
  expect(fixture.readMetadata(retained)).toEqual(metadata);
  fixture.runCensus.set(interruptedRun.runId, { matchingPids: [81235], unverifiedPids: [] });
  await expect(nextStore.prepareRepair(fixture.root, env)).rejects.toThrow(/PID 81235/);
  expect(fixture.current()).toEqual(retained);
  fixture.runCensus.clear();
  using reclaimed = await prepareRepair(nextStore);
  const run = newRun();
  reclaimed.bindRun(run.runId);
  reclaimed.complete(run.runId);
  expect(nextStore.read(fixture.root)).toEqual({ kind: "absent" });
  expect(nextUpdate(nextStore)).toBe("acquired");
});
