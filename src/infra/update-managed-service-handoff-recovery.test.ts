import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as childTree from "../process/child-process-tree.js";
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

it.each(["unverified intermediate-parent descendant", "incomplete census"])(
  "blocks settlement and the next update for an %s",
  async (reason) => {
    const previous = fixture.seed();
    if (reason === "incomplete census") {
      fixture.processCensus.error = "Host process census is incomplete.";
    } else {
      // The census cannot trace a surviving worker through an exited parent.
      fixture.processCensus.unverifiedPids.push(81234);
    }
    await expect(prepareRepair()).rejects.toThrow(
      reason === "incomplete census" ? /census is incomplete/ : /unverified: PID 81234/,
    );
    expect(fixture.current()).toEqual(previous);
    expect(nextUpdate()).toBe("busy");
    expect(ledger.listUpdateRuns({}, { env })).toEqual([]);
    expect(fs.readFileSync(fixture.diagnosticPath, "utf8")).toBe("Retained update diagnostics\n");
  },
);

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

it("settles a dead original's cancelled family with its retained service root", async () => {
  // Redact all sibling roots so host temp-path length cannot truncate this receipt.
  env = { ...env, HOME: path.dirname(fixture.root) };
  const keys = fixture.seedCancellation();
  const family = fixture.rows();
  expect(nextUpdate()).toBe("busy");
  using repair = await prepareRepair();
  // The claim replaces the original; every other family row retires with it.
  expect(fixture.rows().map((row) => row.install_root)).toEqual([fixture.root]);
  const run = newRun();
  repair.bindRun(run.runId);
  repair.complete(run.runId);
  const detail = settlement(run.runId)?.detail ?? "";
  expect(detail).toContain(`cancelled update custody settled: updater PID ${keys.updater.pid}`);
  // History shortens every family key under the fixture home.
  const settled = /Settled keys: (.*)\. Current-installation/.exec(detail)?.[1]?.split(", ");
  expect(settled).toHaveLength(family.length);
  expect(settled).toEqual(
    expect.arrayContaining(
      [keys.slot, keys.service].flatMap((key) => {
        const shortened = `~/${path.basename(key)}`;
        return [shortened, `${shortened}${keys.lineage}`];
      }),
    ),
  );
  expect(fixture.rows()).toEqual([]);
  expect(nextUpdate()).toBe("acquired");
  expect(fixture.store.acquire(keys.service, "next-service", { kind: "update" }).kind).toBe(
    "acquired",
  );
});

it.each([
  ["recent custody", /recovery grace ends at/],
  ["recent retained service root", /recovery grace ends at/],
  ["process referencing the retained service root", /PID 81236/],
  [
    "surviving descendants of the cancelled updater",
    process.platform === "win32"
      ? /descendants remain alive or unverified: PID 81237/
      : /descendants remain live or unverified/,
  ],
  ["unverified candidate", /live or unverified: PID 1000004/],
  ["alias outside the family", /unsupported custody at .*-other\/\.openclaw-update-child-/],
] as const)("retains cancelled custody unchanged for %s", async (reason, expected) => {
  const keys = fixture.seedCancellation(
    reason === "recent custody"
      ? { ageMs: 44 * 60_000 }
      : reason === "recent retained service root"
        ? { serviceAgeMs: 44 * 60_000 }
        : undefined,
  );
  if (reason === "process referencing the retained service root") {
    // The run's own facts name other paths; every retired family key is censused too.
    fixture.pathCensus.set(keys.service, [81236]);
  }
  if (reason === "surviving descendants of the cancelled updater") {
    // Windows descendants are observed by the host census, not a POSIX process group.
    if (process.platform === "win32") {
      fixture.processCensus.matchingPids.push(81237);
    } else {
      const groupAlive = childTree.isChildProcessTreeAlive;
      vi.spyOn(childTree, "isChildProcessTreeAlive").mockImplementation((child) =>
        child.pid === keys.updater.pid ? true : groupAlive(child),
      );
    }
  }
  if (reason === "unverified candidate") {
    fixture.births.set(fixture.candidate.pid, null);
  }
  if (reason === "alias outside the family") {
    const child = fixture.rows().find((row) => row.install_root.endsWith(keys.lineage));
    fixture.insert([{ ...child!, install_root: `${fixture.root}-other${keys.lineage}` }]);
  }
  const family = fixture.rows();
  await expect(prepareRepair()).rejects.toMatchObject({
    name: "ManagedHandoffCustodyRetainedError",
    custody: { key: fixture.root, owner: "original-owner", leaseVersion: 4, reason: expected },
  });
  expect(fixture.rows()).toEqual(family);
  expect(nextUpdate()).toBe("busy");
});

it("preserves a dependent admitted while cancelled custody was inspected", async () => {
  const keys = fixture.seedCancellation();
  const inspecting = createDeferred();
  const observation = createDeferred<typeof fixture.facts>();
  fixture.repairFacts.mockImplementationOnce(() => {
    inspecting.resolve();
    return observation.promise;
  });
  const result = prepareRepair();
  // A repair that skips fact inspection settles first instead of hanging the test.
  await Promise.race([inspecting.promise, result]);
  const mirror = fixture.rows().find((row) => row.install_root === keys.slot);
  fixture.insert([{ ...mirror!, install_root: `${keys.slot}-newer`, updated_at: Date.now() }]);
  const family = fixture.rows();
  observation.resolve(fixture.facts);
  await expect(result).rejects.toThrow("ownership changed; retry");
  expect(fixture.rows()).toEqual(family);
});

it("resumes a failed cancelled-custody repair from its retained original", async () => {
  fixture.seedCancellation();
  const [original] = fixture.rows();
  await expect(
    withRepair(() => {
      throw new Error("Current installation repair failed");
    }),
  ).rejects.toThrow("Current installation repair failed");
  const retained = fixture.current();
  expect(retained.action).toMatchObject({ kind: "triage", phase: "uncertain" });
  expect(fixture.readMetadata(retained)?.source).toEqual({
    owner: original!.owner,
    payload_json: original!.payload_json,
    updated_at: original!.updated_at,
  });
  expect(nextUpdate()).toBe("busy");
  // The interrupted claim's own process is live: report the cancelled custody, keep the claim.
  const custody = {
    key: fixture.root,
    owner: original!.owner,
    leaseVersion: 4,
    lastActivityAt: new Date(original!.updated_at).toISOString(),
  };
  await expect(prepareRepair()).rejects.toMatchObject({
    name: "ManagedHandoffCustodyRetainedError",
    custody: { ...custody, reason: expect.stringContaining(`PID ${process.pid}`) },
  });
  expect(fixture.current()).toEqual(retained);
  // Once that process is gone, grace counts from the cancelled family, not the claim.
  fixture.births.set(process.pid, 20);
  const nextStore = createManagedHandoffLeaseStore();
  using resumed = await prepareRepair(nextStore);
  expect(resumed.cancelledCustody).toEqual(custody);
  const run = newRun();
  resumed.bindRun(run.runId);
  resumed.complete(run.runId);
  expect(settlement(run.runId)?.detail).toContain("cancelled update custody settled");
  expect(fixture.rows()).toEqual([]);
  expect(nextUpdate(nextStore)).toBe("acquired");
});

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

it("settles a prior-boot family with an unreadable recycled owner PID", async () => {
  fixture.seed({ ageMs: 1_000 });
  fixture.births.set(fixture.helper.pid, null);
  const boot = fixture.store.bootIdentity();
  vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
    ...boot,
    identity:
      boot.platform === "win32"
        ? "2026-09-16T03:42:10.5000000Z"
        : "01234567-89ab-cdef-0123-456789abcdee",
  }));
  const nextStore = createManagedHandoffLeaseStore();
  using repair = await prepareRepair(nextStore);
  const run = newRun();
  repair.bindRun(run.runId);
  repair.complete(run.runId);
  expect(nextStore.read(fixture.root)).toEqual({ kind: "absent" });
  expect(nextUpdate(nextStore)).toBe("acquired");
});

it.each(["before", "retained-child", "at-margin", "after", "unreadable", "runtime-holder"])(
  "repairs a legacy handoff using its durable write time and boot time: %s",
  async (observation) => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const bootStartedAt = now - 60_000;
    const before = ["before", "retained-child", "unreadable", "runtime-holder"].includes(
      observation,
    );
    const previous = fixture.seed({
      legacy: "original",
      ageMs: before ? 6 * 60_000 + 1 : observation === "at-margin" ? 6 * 60_000 : 59_999,
    });
    const child =
      observation === "retained-child"
        ? fixture.seed({ legacy: "retained", ageMs: 6 * 60_000 + 1 })
        : undefined;
    fixture.births.set(fixture.helper.pid, null);
    vi.spyOn(fixture.store, "bootIdentity").mockImplementation(() => {
      if (observation === "unreadable") {
        throw new Error("OS boot time unavailable");
      }
      return {
        platform: "win32",
        identity: new Date(bootStartedAt).toISOString().replace(".000Z", ".0000000Z"),
      };
    });
    if (observation === "runtime-holder") {
      fixture.processCensus.matchingPids.push(81234);
    }
    if (!["before", "retained-child"].includes(observation)) {
      await expect(prepareRepair()).rejects.toThrow(
        observation === "runtime-holder" ? /PID 81234/ : /Handoff owners are live or unverified/,
      );
      expect(fixture.store.read(previous.key)).toEqual({ kind: "current", lease: previous });
      expect(nextUpdate()).toBe("busy");
      expect(ledger.listUpdateRuns({}, { env })).toEqual([]);
      return;
    }
    using repair = await prepareRepair();
    const run = newRun();
    repair.bindRun(run.runId);
    if (child) {
      const record = ledger.recordUpdateRunStep;
      vi.spyOn(ledger, "recordUpdateRunStep").mockImplementation((...args) => {
        if (args[1].step === "finalize:handoff-settlement") {
          expect(fixture.store.read(child.key)).toEqual({ kind: "current", lease: child });
        }
        return record(...args);
      });
    }
    repair.complete(run.runId);
    expect(settlement(run.runId)?.status).toBe("completed");
    expect(fixture.store.read(previous.key)).toEqual({ kind: "absent" });
    if (child) {
      expect(fixture.store.read(child.key)).toEqual({ kind: "absent" });
    }
    expect(fixture.store.read(fixture.root)).toEqual({ kind: "absent" });
    expect(nextUpdate()).toBe("acquired");
  },
);

it.each(["missing-recorded", "unknown-recorded", "unknown-current", "unreadable-current"])(
  "preserves owner liveness checks with %s boot identity",
  async (observation) => {
    const previous = fixture.seed({ ageMs: 1_000 });
    fixture.births.set(fixture.helper.pid, null);
    if (observation.endsWith("recorded")) {
      if (previous.action.kind !== "triage" || previous.action.lifetime.kind !== "foreground") {
        throw new Error("Expected a foreground repair fixture");
      }
      const boot = previous.action.lifetime.boot;
      if (observation === "missing-recorded") {
        Reflect.deleteProperty(boot, "identity");
      } else {
        boot.identity = "unknown";
      }
      vi.spyOn(fixture.store, "read").mockReturnValue({ kind: "current", lease: previous });
    } else {
      const boot = fixture.store.bootIdentity();
      vi.spyOn(fixture.store, "bootIdentity").mockImplementation(() => {
        if (observation === "unreadable-current") {
          throw new Error("OS boot identity unavailable");
        }
        return { ...boot, identity: "unknown" };
      });
    }
    await expect(prepareRepair()).rejects.toThrow(
      `Handoff owners are live or unverified: PID ${fixture.helper.pid}`,
    );
    expect(fixture.repairFacts).not.toHaveBeenCalled();
  },
);
