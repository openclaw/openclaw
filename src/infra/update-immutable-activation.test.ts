import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  immutableInstallReadOperations,
  recordImmutablePreparedGeneration,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { activateImmutableUpdate, recoverImmutableUpdate } from "./update-immutable-activation.js";
import {
  candidateSha,
  createImmutableActivationLayout,
  identity,
  previousSha,
  syntheticImmutableGatewayObservation,
  syntheticImmutableServiceObservation,
} from "./update-immutable-activation.test-support.js";
import type {
  ImmutableActivationOperation,
  ImmutableInstallDescriptor,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";
import type { ImmutableProtectionSnapshot } from "./update-immutable-protection-schema.js";
import type { ImmutableServiceObservation } from "./update-immutable-service.js";
import type { ImmutableGatewayObservation } from "./update-immutable-verification.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  install: vi.fn(),
  owner: vi.fn(),
  authority: vi.fn(),
  generation: vi.fn(),
  canary: vi.fn(),
  inspect: vi.fn(),
  current: vi.fn(),
  stopped: vi.fn(),
  drain: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  capture: vi.fn(),
  verifyProtection: vi.fn(),
  unchanged: vi.fn(),
  wait: vi.fn(),
  prepareRecovery: vi.fn(),
  verifyRecovery: vi.fn(),
  operationLock: vi.fn(),
}));
vi.mock("./package-update-activation-immutable-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./package-update-activation-immutable-recovery.js")>()),
  prepareImmutableRecoveryRuntime: mocks.prepareRecovery,
  verifyImmutableRecoveryRuntime: mocks.verifyRecovery,
  resolveImmutableRecoveryCommand: (reference: { helperPath: string }) =>
    `synthetic-node ${reference.helperPath}`,
}));
vi.mock("./update-immutable-install-record.js", () => ({ readImmutableInstallRecord: mocks.read }));
vi.mock("./update-immutable-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-install.js")>()),
  inspectImmutableInstall: mocks.install,
}));
vi.mock("./update-immutable-owner.js", () => ({ withImmutableUpdateOwner: mocks.owner }));
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  captureUpdateCommandExecutorAuthority: mocks.authority,
}));
vi.mock("./update-immutable-generation.js", () => ({
  verifyImmutableGeneration: mocks.generation,
}));
vi.mock("./update-candidate-canary.js", () => ({ validateUpdateCandidateCanary: mocks.canary }));
vi.mock("./update-immutable-service.js", () => ({
  inspectImmutableActivationService: mocks.inspect,
  assertImmutableServiceProcessCurrent: mocks.current,
  assertImmutableServiceStoppedCurrent: mocks.stopped,
  stopImmutableService: mocks.stop,
  startImmutableService: mocks.start,
}));
vi.mock("../cli/update-cli/update-command-service-drain.js", () => ({
  withGatewayMaintenanceDrain: mocks.drain,
}));
vi.mock("./update-immutable-protection.js", () => ({
  captureImmutableProtection: mocks.capture,
  assertImmutableProtectionUnchanged: mocks.unchanged,
  verifyImmutableProtection: mocks.verifyProtection,
}));
vi.mock("./update-immutable-verification.js", () => ({ waitForImmutableGateway: mocks.wait }));
vi.mock("../config/io.factory.js", () => ({
  createConfigIO: () => ({ readBestEffortConfigSnapshot: async () => ({ sourceConfig: {} }) }),
}));
vi.mock("../daemon/service-operation-lock.js", () => ({
  withGatewayServiceOperationLock: mocks.operationLock,
}));
vi.mock("./update-finalization-budget.js", () => ({
  resolveUpdateFinalizationTimeoutMs: async () => 120_000,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let descriptor: ImmutableInstallDescriptor;
let candidate: ImmutablePreparedGeneration;
let serving: { pid: number; generationPath: string } | null;
let nextPid: number;
let events: string[];
let outcomes: ImmutableGatewayObservation["outcome"][];
let stoppedService: ImmutableActivationOperation["stoppedService"];
let recordedStops: Array<ImmutableActivationOperation["stoppedService"]>;
let protection: ImmutableProtectionSnapshot;
let nativeOperationActive: boolean;
const selectedSha = () => path.basename(fs.realpathSync(path.join(root, "current")));
const journalPath = () => resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
const read = () =>
  immutableInstallReadOperations["immutableInstall.read"](
    { root },
    { path: journalPath(), env: process.env },
  );

const serviceObservation = () => syntheticImmutableServiceObservation(descriptor, serving);

describe.skipIf(process.platform !== "linux")("immutable activation orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    events = [];
    outcomes = [];
    stoppedService = undefined;
    recordedStops = [];
    nextPid = 4_200;
    nativeOperationActive = false;
    const parent = fs.realpathSync(dirs.make("immutable-activation-"));
    ({ root, descriptor, candidate, protection } = createImmutableActivationLayout(parent));
    serving = { pid: nextPid++, generationPath: descriptor.current.path };
    const assertCurrent = () => {};
    const authority: ImmutableActivationOperation["authority"] = {
      databasePath: journalPath(),
      databaseIdentity: identity(journalPath()),
      parentIdentity: identity(path.dirname(journalPath())),
      installKey: root,
      owner: "synthetic-executor",
    };
    mocks.read.mockImplementation(async () => read());
    mocks.install.mockImplementation(async () => ({
      root,
      activationEnabled: read().descriptor.activationEnabled,
    }));
    mocks.owner.mockImplementation(async (_root, run) => run(assertCurrent, { assertCurrent }));
    mocks.operationLock.mockImplementation(async (_env, operation) => {
      if (nativeOperationActive) {
        throw new Error("synthetic native service lock already held");
      }
      nativeOperationActive = true;
      let active = true;
      try {
        return await operation(() => {
          if (!active || !nativeOperationActive) {
            throw new Error("synthetic native service lease ended");
          }
        });
      } finally {
        active = false;
        nativeOperationActive = false;
      }
    });
    mocks.authority.mockReturnValue(authority);
    mocks.prepareRecovery.mockResolvedValue({
      root,
      path: path.join(path.dirname(journalPath()), `recovery-${previousSha}`),
      sha: previousSha,
      identity: "1:9",
      buildDigest: descriptor.current.buildDigest,
      helperPath: path.join(path.dirname(journalPath()), "recovery.mjs"),
      helperIdentity: "1:10",
      helperDigest: "6".repeat(64),
    });
    mocks.verifyRecovery.mockImplementation(async ({ assertCurrent: check }) => check());
    mocks.generation.mockImplementation(async (generationPath: string) => ({
      identity: identity(generationPath),
      buildDigest:
        generationPath === candidate.path ? candidate.buildDigest : descriptor.current.buildDigest,
    }));
    mocks.canary.mockImplementation(async ({ root: generationPath }) => {
      events.push(`canary:${path.basename(generationPath)}`);
      return {
        status: "ok",
        phase: "readiness",
        steps: [
          {
            name: "candidate-gateway-startup",
            command: "gateway run",
            durationMs: 1,
            exitCode: 0,
          },
        ],
        durationMs: 1,
        logTail: [],
      };
    });
    mocks.inspect.mockImplementation(async ({ assertCurrent: check }) => {
      check();
      return serviceObservation();
    });
    mocks.current.mockImplementation((observation: ImmutableServiceObservation) => {
      if (
        serving?.pid !== observation.pid ||
        serving?.generationPath !== observation.generationPath
      ) {
        throw new Error("synthetic serving process changed");
      }
    });
    mocks.stopped.mockImplementation((observed: ImmutableActivationOperation["stoppedService"]) => {
      if (
        serving !== null ||
        !stoppedService ||
        observed?.pid !== stoppedService.pid ||
        observed.processStartTicks !== stoppedService.processStartTicks ||
        observed.controlGroup !== stoppedService.controlGroup
      ) {
        throw new Error("synthetic stopped-service custody changed");
      }
    });
    mocks.drain.mockImplementation(async ({ assertCurrent: check }, stop) => {
      check();
      events.push(`drain:${selectedSha()}`);
      return stop({
        prepareEffect: async (beforeCommit: () => void) => {
          check();
          beforeCommit();
        },
      });
    });
    mocks.stop.mockImplementation(async ({ assertCurrent: check, expected, prepareEffect }) => {
      check();
      await prepareEffect?.();
      if (!nativeOperationActive) {
        throw new Error("synthetic stop outside service lease");
      }
      events.push(`stop:${selectedSha()}`);
      recordedStops.push(read().activation?.operation?.stoppedService);
      stoppedService = {
        pid: expected.pid,
        processStartTicks: expected.processStartTicks,
        controlGroup: expected.controlGroup,
      };
      serving = null;
    });
    mocks.start.mockImplementation(async ({ assertCurrent: check, beforeEffect }) => {
      check();
      if (!nativeOperationActive) {
        throw new Error("synthetic start outside service lease");
      }
      beforeEffect?.();
      events.push(`start:${selectedSha()}`);
      serving = { pid: nextPid++, generationPath: fs.realpathSync(path.join(root, "current")) };
    });
    mocks.capture.mockResolvedValue(protection);
    mocks.unchanged.mockImplementation((_snapshot, { assertCurrent: check }) => check());
    mocks.verifyProtection.mockImplementation((_snapshot, { assertCurrent: check }) => {
      check();
      return { configMigrated: false };
    });
    mocks.wait.mockImplementation(async ({ generation, assertCurrent: check }) => {
      check();
      events.push(`verify:${generation.sha}`);
      const outcome = outcomes.shift() ?? "verified";
      return syntheticImmutableGatewayObservation(descriptor, generation, serving, outcome);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("activates a prepared generation in lifecycle order and retires only verified success", async () => {
    const receipts: string[] = [];
    const result = await activateImmutableUpdate({
      root,
      expectedPrepared: candidate,
      timeoutMs: 30_000,
      drainTimeoutMs: 30_000,
      onReceipt: (line) => receipts.push(line),
    });
    expect(result.status).toBe("succeeded");
    expect(result.installation).toMatchObject({
      currentSha: candidateSha,
      currentPath: candidate.path,
    });
    expect(result.installation.prepared).toBeUndefined();
    expect(events).toEqual([
      `canary:${candidateSha}`,
      `drain:${previousSha}`,
      `stop:${previousSha}`,
      `start:${candidateSha}`,
      `verify:${candidateSha}`,
      `canary:${candidateSha}`,
      `verify:${candidateSha}`,
    ]);
    expect(receipts).toContain("immutable:prepared");
    expect(receipts.at(-1)).toBe("immutable:retired");
    expect(selectedSha()).toBe(candidateSha);
    expect(read()).toMatchObject({
      prepared: null,
      activation: {
        previous: { sha: previousSha },
        lastResult: {
          operationId: result.operationId,
          outcome: "succeeded",
          selectedSha: candidateSha,
          gateway: {
            pid: 4_201,
            bootId: "boot-4201",
            version: "2026.10.3",
            buildId: candidateSha,
          },
        },
      },
    });
    expect(read().activation?.operation).toBeUndefined();
    expect(recordedStops).toEqual([
      {
        pid: 4_200,
        processStartTicks: "420000",
        controlGroup: "/system.slice/immutable-fixture.service",
      },
    ]);
    expect(mocks.drain).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000, drainPolicy: "interrupt-after-drain" }),
      expect.any(Function),
    );
  });

  it("leaves a preparation-only adoption serving without activation effects", async () => {
    const current = read();
    const { activationEnabled: _enabled, ...disabled } = current.descriptor;
    const preparationOnly = updateImmutableInstallRecord(
      current,
      { ...current, descriptor: { ...disabled, version: 1 } },
      () => {},
    );
    await expect(activateImmutableUpdate({ root, expectedPrepared: candidate })).rejects.toThrow(
      "activation is disabled",
    );
    expect(events).toEqual([]);
    expect(read()).toEqual(preparationOnly);
    expect(selectedSha()).toBe(previousSha);
  });

  it("refuses another preparation admitted before activation acquires its executor", async () => {
    const otherSha = "c".repeat(40);
    const otherPath = path.join(root, "releases", otherSha);
    fs.mkdirSync(otherPath, { mode: 0o755 });
    const replacement = {
      ...candidate,
      sha: otherSha,
      path: otherPath,
      identity: identity(otherPath),
      buildDigest: "8".repeat(64),
      preparedAtMs: candidate.preparedAtMs + 1,
    };
    const enter = mocks.owner.getMockImplementation();
    if (!enter) {
      throw new Error("Missing executor fixture");
    }
    mocks.owner.mockImplementationOnce(async (...args) => {
      recordImmutablePreparedGeneration(read(), replacement, () => {});
      return enter(...args);
    });
    await expect(activateImmutableUpdate({ root, expectedPrepared: candidate })).rejects.toThrow(
      "Prepared immutable generation changed before activation",
    );
    expect(read().prepared).toEqual(replacement);
    expect(selectedSha()).toBe(previousSha);
    expect(events).toEqual([]);
    expect(mocks.drain).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)(
    "repairs interrupted v%s control metadata without activating a prepared generation",
    async (version) => {
      const current = read();
      const { activationEnabled: _enabled, ...disabled } = current.descriptor;
      const committed =
        version === 1
          ? updateImmutableInstallRecord(
              current,
              { ...current, descriptor: { ...disabled, version } },
              () => {},
            )
          : current;
      createHotSqliteRollbackJournal({
        path: journalPath(),
        mutationSql:
          "UPDATE immutable_installation SET prepared_json = 'null', revision = revision + 100",
      });
      expect(read).toThrow(expect.objectContaining({ errcode: 776 }));
      const receipts: string[] = [];
      const result = await recoverImmutableUpdate({
        root,
        onReceipt: (line) => receipts.push(line),
      });
      expect(result).toMatchObject({
        status: "already-current",
        installation: { currentSha: previousSha, prepared: { sha: candidateSha } },
      });
      expect(read()).toEqual(committed);
      expect(receipts).toEqual(["immutable:control-recovered"]);
      expect(events).toEqual([]);
      expect(selectedSha()).toBe(previousSha);
      expect(mocks.operationLock).not.toHaveBeenCalled();
      expect(mocks.verifyRecovery).not.toHaveBeenCalled();
    },
  );

  it("rolls a real candidate failure back to its predecessor and retains recovery evidence", async () => {
    outcomes = ["failed", "verified"];
    const result = await activateImmutableUpdate({ root, expectedPrepared: candidate });
    expect(result).toMatchObject({ status: "rolled-back", phase: "rolled-back" });
    expect(events).toEqual([
      `canary:${candidateSha}`,
      `drain:${previousSha}`,
      `stop:${previousSha}`,
      `start:${candidateSha}`,
      `verify:${candidateSha}`,
      `canary:${previousSha}`,
      `drain:${candidateSha}`,
      `stop:${candidateSha}`,
      `start:${previousSha}`,
      `verify:${previousSha}`,
      `canary:${previousSha}`,
      `verify:${previousSha}`,
    ]);
    expect(selectedSha()).toBe(previousSha);
    expect(read().activation).toMatchObject({
      operation: {
        operationId: result.operationId,
        phase: "rolled-back",
        failure: "candidate-verification-failed",
        previous: { sha: previousSha },
        candidate: { sha: candidateSha },
      },
      lastResult: {
        operationId: result.operationId,
        outcome: "rolled-back",
        selectedSha: previousSha,
      },
    });
  });

  it("rolls back a failed native start after observing that the candidate never became live", async () => {
    mocks.start.mockImplementationOnce(async ({ assertCurrent: check, beforeEffect }) => {
      check();
      beforeEffect?.();
      events.push(`start-failed:${selectedSha()}`);
      throw new Error("synthetic systemd start failed");
    });
    const result = await activateImmutableUpdate({ root, expectedPrepared: candidate });
    expect(result).toMatchObject({ status: "rolled-back", phase: "rolled-back" });
    expect(selectedSha()).toBe(previousSha);
    expect(events).toEqual([
      `canary:${candidateSha}`,
      `drain:${previousSha}`,
      `stop:${previousSha}`,
      `start-failed:${candidateSha}`,
      `canary:${previousSha}`,
      `start:${previousSha}`,
      `verify:${previousSha}`,
      `canary:${previousSha}`,
      `verify:${previousSha}`,
    ]);
    expect(read().activation?.operation).toMatchObject({
      operationId: result.operationId,
      phase: "rolled-back",
      failure: "candidate-start-failed",
    });
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it.each(["throws", "failed", "still-starting", "unverified"] as const)(
    "settles a stopped candidate recovery retry that %s through the candidate owner",
    async (outcome) => {
      let executorActive = true;
      mocks.owner.mockImplementationOnce(async (_root, run) => {
        const assertCurrent = () => {
          if (!executorActive) {
            throw new Error("synthetic executor ended before candidate start");
          }
        };
        return run(assertCurrent, { assertCurrent });
      });
      await expect(
        activateImmutableUpdate({
          root,
          expectedPrepared: candidate,
          onReceipt: (line) => {
            if (line === "immutable:starting") {
              executorActive = false;
              throw new Error("synthetic updater crash");
            }
          },
        }),
      ).rejects.toThrow("synthetic executor ended before candidate start");
      expect(selectedSha()).toBe(candidateSha);
      expect(serving).toBeNull();
      expect(read().activation?.operation?.phase).toBe("starting");
      expect(mocks.start).not.toHaveBeenCalled();

      outcomes = outcome === "throws" ? ["failed"] : ["failed", outcome];
      if (outcome === "throws") {
        mocks.start.mockImplementationOnce(async ({ assertCurrent: check, beforeEffect }) => {
          check();
          beforeEffect?.();
          throw new Error("synthetic recovery start failed");
        });
      }
      const result = await recoverImmutableUpdate({ root });
      const rolledBack = outcome === "throws" || outcome === "failed";
      expect(result.status).toBe(rolledBack ? "rolled-back" : "pending");
      expect(selectedSha()).toBe(rolledBack ? previousSha : candidateSha);
      expect(result.installation.currentSha).toBe(selectedSha());
      expect(mocks.start.mock.calls.map(([params]) => params.descriptor.current.sha)).toEqual(
        rolledBack ? [candidateSha, previousSha] : [candidateSha],
      );
      expect(mocks.stop.mock.calls.map(([params]) => params.descriptor.current.sha)).toEqual(
        outcome === "failed" ? [previousSha, candidateSha] : [previousSha],
      );
      expect(read().activation?.operation).toMatchObject({ candidate: { sha: candidateSha } });
      if (rolledBack) {
        expect(read().activation?.operation).toMatchObject({
          phase: "rolled-back",
          failure:
            outcome === "throws" ? "candidate-start-failed" : "candidate-verification-failed",
        });
      }
      expect(read().activation?.lastResult?.outcome).toBe(rolledBack ? "rolled-back" : undefined);
    },
  );

  it.each(["native inspection", "handoff dispatch"] as const)(
    "preserves the serving predecessor when protected state changes during %s",
    async (window) => {
      const originalServing = serving;
      let changed = false;
      let hostCommitted = false;
      mocks.unchanged.mockImplementation((_snapshot, { assertCurrent: check }) => {
        check();
        if (changed) {
          throw new Error("protected state changed before host commitment");
        }
      });
      mocks.drain.mockImplementation(async ({ assertCurrent: check }, stop) => {
        check();
        return stop({
          prepareEffect: async (beforeCommit?: () => void) => {
            beforeCommit?.();
            await Promise.resolve();
            if (window === "handoff dispatch") {
              changed = true;
            }
            beforeCommit?.();
            hostCommitted = true;
            serving = null;
          },
        });
      });
      mocks.stop.mockImplementationOnce(async ({ prepareEffect, beforeEffect }) => {
        await Promise.resolve();
        if (window === "native inspection") {
          changed = true;
        }
        await prepareEffect();
        beforeEffect();
        events.push("unexpected-native-stop");
      });
      await expect(activateImmutableUpdate({ root, expectedPrepared: candidate })).rejects.toThrow(
        "protected state changed",
      );
      expect(hostCommitted).toBe(false);
      expect(serving).toEqual(originalServing);
      expect(selectedSha()).toBe(previousSha);
      expect(events).not.toContain("unexpected-native-stop");
      expect(read().activation?.operation).toMatchObject({ phase: "stopping" });
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it.each(["capture", "rehearsal"] as const)(
    "refuses a foreign config write during rollback %s without accepting a new baseline",
    async (window) => {
      outcomes = ["failed"];
      const original = protection;
      const foreign = {
        ...original,
        capturedAtMs: 2,
        config: original.config.map((entry) => ({ ...entry, hash: "7".repeat(64) })),
      };
      let foreignWrite = false;
      let captures = 0;
      mocks.capture.mockImplementation(async () => {
        if (++captures > 1 && window === "capture") {
          foreignWrite = true;
        }
        return foreignWrite ? foreign : original;
      });
      const canary = mocks.canary.getMockImplementation();
      if (!canary) {
        throw new Error("Missing canary fixture");
      }
      mocks.canary.mockImplementation(async (params) => {
        const result = await canary(params);
        if (window === "rehearsal" && params.root === descriptor.current.path) {
          foreignWrite = true;
        }
        return result;
      });
      const checkProtection = (
        snapshot: ImmutableProtectionSnapshot,
        options: { assertCurrent: () => void },
      ) => {
        options.assertCurrent();
        if (foreignWrite && snapshot.config[0]?.hash === original.config[0]?.hash) {
          throw new Error("foreign config write after protection capture");
        }
      };
      mocks.unchanged.mockImplementation(checkProtection);
      mocks.verifyProtection.mockImplementation((snapshot, options) => {
        checkProtection(snapshot, options);
        return { configMigrated: false };
      });
      await expect(activateImmutableUpdate({ root, expectedPrepared: candidate })).rejects.toThrow(
        "foreign config write",
      );
      expect(read().activation?.operation?.protection).toEqual(original);
      expect(selectedSha()).toBe(candidateSha);
      expect(serving?.generationPath).toBe(candidate.path);
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(read().activation?.lastResult).toBeUndefined();
    },
  );

  it.each(["rollback-stopping", "rollback-publishing"] as const)(
    "resumes %s toward the predecessor after a crash with the failed candidate stopped",
    async (phase) => {
      outcomes = ["failed"];
      const stop = mocks.stop.getMockImplementation();
      if (!stop) {
        throw new Error("Missing service-stop fixture");
      }
      mocks.stop.mockImplementation(async (params) => {
        await stop(params);
        if (phase === "rollback-stopping" && selectedSha() === candidateSha) {
          throw new Error("synthetic rollback interrupted");
        }
      });
      let interrupted = false;
      await expect(
        activateImmutableUpdate({
          root,
          expectedPrepared: candidate,
          onReceipt: (line) => {
            if (
              !interrupted &&
              phase === "rollback-publishing" &&
              line === "immutable:rollback-publishing"
            ) {
              interrupted = true;
              throw new Error("synthetic rollback interrupted");
            }
          },
        }),
      ).rejects.toThrow("synthetic rollback interrupted");
      expect(read().activation?.operation).toMatchObject({
        phase,
        stoppedService: { pid: 4_201, processStartTicks: "420100" },
      });
      expect(selectedSha()).toBe(candidateSha);
      expect(serving).toBeNull();
      const beforeRecovery = events.length;
      outcomes = ["failed", "verified"];
      const result = await recoverImmutableUpdate({ root });
      expect(result.status).toBe("rolled-back");
      expect(events.slice(beforeRecovery)).toEqual([
        `verify:${candidateSha}`,
        `start:${previousSha}`,
        `verify:${previousSha}`,
        `canary:${previousSha}`,
        `verify:${previousSha}`,
      ]);
      expect(selectedSha()).toBe(previousSha);
      expect(serving?.generationPath).toBe(descriptor.current.path);
      expect(read().activation?.operation).toBeUndefined();
      expect(read().activation?.lastResult?.outcome).toBe("rolled-back");
    },
  );

  it("refuses pointer publication when the stopped-service owner reports remaining processes", async () => {
    mocks.stopped.mockImplementation(() => {
      throw new Error("synthetic cgroup still populated");
    });
    await expect(activateImmutableUpdate({ root, expectedPrepared: candidate })).rejects.toThrow(
      "synthetic cgroup still populated",
    );
    expect(selectedSha()).toBe(previousSha);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(read().activation?.operation).toMatchObject({
      phase: "publishing",
      failure: "activation-interrupted",
    });
  });

  it.each(["still-starting", "unverified"] as const)(
    "retains a %s candidate without rolling back",
    async (outcome) => {
      outcomes = [outcome];
      const result = await activateImmutableUpdate({ root, expectedPrepared: candidate });
      expect(result.status).toBe("pending");
      expect(result.installation.currentSha).toBe(candidateSha);
      expect(selectedSha()).toBe(candidateSha);
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(read().activation?.operation).toMatchObject({
        operationId: result.operationId,
        phase: "verifying",
      });
      expect(read().activation?.lastResult).toBeUndefined();
      expect(result.recoveryCommand).toContain(
        path.join(path.dirname(journalPath()), "recovery.mjs"),
      );
    },
  );

  it.each(["candidate", "previous"] as const)(
    "retires a healthy selected %s during recovery without another restart",
    async (selected) => {
      outcomes = selected === "candidate" ? ["unverified"] : ["failed", "verified"];
      const initial = await activateImmutableUpdate({ root, expectedPrepared: candidate });
      const starts = mocks.start.mock.calls.length;
      const stops = mocks.stop.mock.calls.length;
      const pid = serving?.pid;
      const retainedRecovery = read().activation?.operation?.recovery;
      const result = await recoverImmutableUpdate({ root });
      expect(result).toMatchObject({
        status: selected === "candidate" ? "succeeded" : "rolled-back",
        operationId: initial.operationId,
      });
      expect(mocks.start).toHaveBeenCalledTimes(starts);
      expect(mocks.stop).toHaveBeenCalledTimes(stops);
      expect(serving?.pid).toBe(pid);
      expect(mocks.verifyRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ reference: retainedRecovery }),
      );
      expect(read().activation?.operation).toBeUndefined();
      expect(read().activation?.lastResult?.selectedSha).toBe(
        selected === "candidate" ? candidateSha : previousSha,
      );
      expect(read().activation?.lastResult?.gateway).toEqual({
        pid,
        bootId: `boot-${pid}`,
        version: "2026.10.3",
        buildId: selected === "candidate" ? candidateSha : previousSha,
      });
    },
  );

  it("retains accepted startup writes when the post-start canary fails and later recovers a healthy PID", async () => {
    const accepted = { ...protection, capturedAtMs: 2 };
    mocks.capture.mockResolvedValueOnce(protection).mockResolvedValue(accepted);
    const canary = mocks.canary.getMockImplementation();
    if (!canary) {
      throw new Error("Missing canary fixture");
    }
    let canaries = 0;
    mocks.canary.mockImplementation(async (params) => {
      if (++canaries === 2) {
        throw new Error("synthetic post-start canary failed");
      }
      return canary(params);
    });
    const result = await activateImmutableUpdate({ root, expectedPrepared: candidate });
    expect(result).toMatchObject({ status: "pending", reason: "post-start-canary-unverified" });
    expect(selectedSha()).toBe(candidateSha);
    expect(read().activation?.operation?.protection).toEqual(accepted);
    expect(read().activation?.lastResult).toBeUndefined();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    serving = { pid: nextPid++, generationPath: candidate.path };
    const recovered = await recoverImmutableUpdate({ root });
    expect(recovered.status).toBe("succeeded");
    expect(read().activation?.lastResult?.gateway?.pid).toBe(serving.pid);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("keeps recovery pending when the serving process changes after the post-start canary", async () => {
    const wait = mocks.wait.getMockImplementation();
    if (!wait) {
      throw new Error("Missing readiness fixture");
    }
    let observations = 0;
    mocks.wait.mockImplementation(async (params) => {
      if (++observations === 2) {
        serving = { pid: nextPid++, generationPath: candidate.path };
      }
      return wait(params);
    });
    const result = await activateImmutableUpdate({ root, expectedPrepared: candidate });
    expect(result).toMatchObject({ status: "pending", reason: "post-start-generation-unverified" });
    expect(selectedSha()).toBe(candidateSha);
    expect(mocks.canary).toHaveBeenCalledTimes(2);
    expect(read().activation?.lastResult).toBeUndefined();
    expect(read().activation?.operation).toBeDefined();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("retains the stopped predecessor and durable operation when activation is interrupted", async () => {
    let interrupted = false;
    await expect(
      activateImmutableUpdate({
        root,
        expectedPrepared: candidate,
        onReceipt: (line) => {
          if (!interrupted && line === "immutable:publishing") {
            interrupted = true;
            throw new Error("synthetic updater interrupted");
          }
        },
      }),
    ).rejects.toThrow("synthetic updater interrupted");
    expect(selectedSha()).toBe(previousSha);
    expect(serving).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(read().activation?.operation).toMatchObject({
      phase: "publishing",
      failure: "activation-interrupted",
    });
    expect(read().activation?.lastResult).toBeUndefined();
  });
});
