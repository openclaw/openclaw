import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { createManagedHandoffRecoveryFixture } from "./update-managed-service-handoff-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
} from "./update-run-ledger.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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

async function prepareRepair() {
  const repair = await fixture.store.prepareRepair(fixture.root, env);
  if (!repair) {
    throw new Error("Expected an explicit handoff repair claim");
  }
  return repair;
}

describe("managed handoff lease repair", () => {
  it("records the settlement receipt before releasing a dead legacy lease and admits the next update", async () => {
    const previous = fixture.seed();
    let receiptAtRelease: unknown;
    const release = fixture.store.release;
    vi.spyOn(fixture.store, "release").mockImplementation((lease) => {
      receiptAtRelease = getUpdateRun(run.runId, { env })?.steps.find(
        (step) => step.step === "finalize:handoff-settlement",
      );
      return release(lease);
    });
    using repair = await prepareRepair();
    repair.assertCurrent();
    const claimed = fixture.current();
    expect(claimed.owner).not.toBe(previous.owner);
    expect(claimed.helper.pid).toBe(process.pid);
    const run = createUpdateRun({ trigger: "cli" }, { env });
    expect(() => repair.complete(run.runId)).toThrow("requires its bound repair run");
    repair.bindRun(run.runId);

    repair.complete(run.runId);

    expect(receiptAtRelease).toMatchObject({
      status: "completed",
      endedAtMs: expect.any(Number),
      detail: expect.stringContaining("legacy handoff lease reclaimed"),
    });
    expect(fixture.store.read(fixture.root)).toEqual({ kind: "absent" });
    expect(fixture.store.acquire(fixture.root, "next-update", { kind: "update" }).kind).toBe(
      "acquired",
    );
    finishUpdateRun(run.runId, { status: "succeeded" }, { env });
    expect(getUpdateRun(run.runId, { env })?.steps).toContainEqual(receiptAtRelease);
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
    const previous = fixture.seed(
      grace
        ? {
            ageMs: (largerTimeout ? 46 : 44) * 60_000,
            timeoutMs: largerTimeout ? 90 * 60_000 : undefined,
          }
        : {},
    );
    let expected: string | RegExp | Error;
    if (grace) {
      expected = new Date(previous.updatedAt + (largerTimeout ? 90 : 45) * 60_000).toISOString();
    } else if (reason === "live owner" || reason === "unverified owner") {
      fixture.births.set(
        fixture.helper.pid,
        reason === "live owner" ? Number(fixture.helper.startIdentity) : null,
      );
      expected = new RegExp("live or unverified: PID " + fixture.helper.pid);
    } else if (reason === "unverified descendant") {
      fixture.processCensus.unverifiedPids.push(81234);
      fixture.processCensus.error =
        "Retry update repair as Administrator using the same Windows account.";
      expected = new Error(
        `Handoff descendants remain alive or unverified: PID 81234. ${fixture.processCensus.error}`,
      );
    } else {
      fixture.processCensus.matchingPids.push(81234);
      expected = /PID 81234.*openclaw update repair/;
    }
    await expect(prepareRepair()).rejects.toThrow(expected);
    expect(fixture.current()).toEqual(previous);
    if (reason === "live descendant") {
      expect(fixture.store.acquire(fixture.root, "next-update", { kind: "update" }).kind).toBe(
        "busy",
      );
      expect(listUpdateRuns({}, { env })).toEqual([]);
    }
  });

  it("preserves an incomplete rollback across repair state overrides", async () => {
    const previous = fixture.seed();
    fixture.repairFacts.mockRestore();
    vi.spyOn(os, "tmpdir").mockReturnValue(fixture.root);
    const run = createUpdateRun(
      {
        trigger: "cli",
        origin: { driver: { ...previous.executor, host: os.hostname() } },
      },
      { env },
    );
    recordUpdateRunStep(run.runId, { step: "package rollback", status: "completed" }, { env });
    finishUpdateRun(run.runId, { status: "failed", reason: "interrupted-restoration" }, { env });
    const recorded = getUpdateRun(run.runId, { env });

    await expect(prepareRepair()).rejects.toThrow(/rollback.*update status/u);

    const directory = path.join(fixture.root, "openclaw-update-run-handoff-original-profile");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, "handoff.json"),
      JSON.stringify({
        updateLeaseOwner: previous.owner,
        updateLeaseKey: previous.key,
        runId: run.runId,
        cwd: fixture.root,
      }),
      { mode: 0o600 },
    );
    await expect(
      fixture.store.prepareRepair(fixture.root, {
        ...env,
        OPENCLAW_STATE_DIR: path.join(fixture.root, "other-state"),
      }),
    ).rejects.toThrow("original profile and state overrides");

    expect(fixture.current()).toEqual(previous);
    expect(getUpdateRun(run.runId, { env })).toEqual(recorded);
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
      const run =
        failure === "settlement receipt" ? createUpdateRun({ trigger: "cli" }, { env }) : undefined;
      await expect(
        (async () => {
          using repair = await prepareRepair();
          repair.assertCurrent();
          if (run) {
            repair.bindRun(run.runId);
            finishUpdateRun(run.runId, { status: "failed" }, { env });
            repair.complete(run.runId);
          } else {
            throw new Error("Current installation repair failed");
          }
        })(),
      ).rejects.toThrow(run ? "settlement was not recorded" : "Current installation repair failed");
      const retained = fixture.current();
      expect(retained.owner).not.toBe(previous.owner);
      expect(retained.helper.pid).toBe(process.pid);
      expect(retained.action).toMatchObject({ kind: "triage", phase: "uncertain" });
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
          getUpdateRun(run.runId, { env })?.steps.some(
            (step) => step.step === "finalize:handoff-settlement",
          ),
        ).toBe(false);
      } else {
        const olderWriterGeneration = fixture.replaceHeartbeat(retained);
        expect(fixture.readMetadata(olderWriterGeneration)).toBeNull();
        expect(fixture.store.acquire(fixture.root, "next-update", { kind: "update" }).kind).toBe(
          "busy",
        );
        expect(listUpdateRuns({}, { env })).toEqual([]);
      }
    },
  );

  it("preserves interrupted repair evidence across reboot until explicit repair settles it", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const original = fixture.seed();
    const interruptedRun = createUpdateRun({ trigger: "cli" }, { env });
    {
      using repair = await prepareRepair();
      repair.bindRun(interruptedRun.runId);
    }
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
    expect(nextStore.acquire(fixture.root, "next-update", { kind: "update" }).kind).toBe("busy");
    expect(nextStore.release(retained)).toBe(false);
    expect(fixture.current()).toEqual(retained);
    expect(fixture.readMetadata(retained)).toEqual(metadata);
    fixture.runCensus.set(interruptedRun.runId, { matchingPids: [81235], unverifiedPids: [] });
    await expect(nextStore.prepareRepair(fixture.root, env)).rejects.toThrow(/PID 81235/);
    expect(fixture.current()).toEqual(retained);
    fixture.runCensus.clear();
    using reclaimed = await nextStore.prepareRepair(fixture.root, env);
    expect(reclaimed).not.toBeNull();
    const run = createUpdateRun({ trigger: "cli" }, { env });
    reclaimed!.bindRun(run.runId);
    reclaimed!.complete(run.runId);
    expect(nextStore.read(fixture.root)).toEqual({ kind: "absent" });
    expect(nextStore.acquire(fixture.root, "next-update", { kind: "update" }).kind).toBe(
      "acquired",
    );
  });
});
