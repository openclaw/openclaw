import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { readManagedHandoffRepairFacts } from "./update-managed-service-handoff-cleanup.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import { retainedCheckpointBinding } from "./update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  retainedTerminalRecord,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import { createUpdateRun } from "./update-run-ledger.js";
import { listUpdateRunsAsync } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { createUpdateRunRecordFixture } from "./update-run-record.test-support.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";

vi.mock("./update-run-reader.js", () => ({ listUpdateRunsAsync: vi.fn() }));
vi.mock("./update-run-recovery-admission.js", () => ({ assertUpdateRecoveryAdmission: vi.fn() }));

const dirs = useStateDatabaseTempDirs();
let root: string;
let env: NodeJS.ProcessEnv;
let lease: ManagedHandoffLease;
const history = vi.mocked(listUpdateRunsAsync);
const readFacts = (runId?: string) => readManagedHandoffRepairFacts(lease, env, runId);
const localDriver = (identity = lease.executor) => ({ ...identity, host: os.hostname() });

beforeEach(async () => {
  root = await fs.realpath(dirs.make("handoff-repair-facts-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  env = { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const payload = {
    version: 2 as const,
    executor: { pid: 1001, startIdentity: "executor-start" },
    helper: { pid: 1002, startIdentity: "helper-start" },
    action: { kind: "update" as const },
  };
  lease = {
    ...payload,
    payload: JSON.stringify(payload),
    key: path.join(root, "installation"),
    owner: "handoff-correlation",
    updatedAt: 42,
  };
  history.mockReset().mockResolvedValue([]);
  vi.mocked(assertUpdateRecoveryAdmission).mockReset().mockResolvedValue(undefined);
});

async function helper(name: string, fields: Record<string, unknown> = {}) {
  const directory = path.join(root, `openclaw-update-run-handoff-${name}`);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(
    path.join(directory, "handoff.json"),
    JSON.stringify({
      cwd: directory,
      runId: "retained-run",
      updateLeaseOwner: lease.owner,
      updateLeaseKey: lease.key,
      ...fields,
    }),
    { mode: 0o600 },
  );
  return directory;
}

function run(
  runId: string,
  origin: UpdateRunRecord["origin"] = { driver: localDriver() },
): UpdateRunRecord {
  return createUpdateRunRecordFixture(runId, {
    origin,
    reason: "update-failed",
    createdAtMs: 10,
    updatedAtMs: 20,
    finishedAtMs: 20,
  });
}

async function expectFacts(
  runId: string,
  artifactPaths: string[],
  ...drivers: ReturnType<typeof localDriver>[]
) {
  expect(await readFacts()).toEqual({
    runIds: [runId],
    artifactPaths,
    drivers: [lease.helper, lease.executor, ...drivers],
    timeoutMs: null,
  });
}

describe("managed handoff repair facts", () => {
  it.each(["S-1-5-21-100", undefined])(
    "reads the launching SID from retained history after helper cleanup (%s)",
    async (sid) => {
      history.mockResolvedValue([
        run("retained-run", { windowsUserSid: sid, driver: localDriver() }),
      ]);
      expect((await readFacts()).windowsUserSid).toBe(sid);
    },
  );

  it("keeps only exact helper owner/key artifacts and their retained capture paths", async () => {
    await helper("wrong-owner", { updateLeaseOwner: "other" });
    await helper("wrong-key", { updateLeaseKey: path.join(root, "other") });
    const context = path.join(root, "failure.json");
    const directory = await helper("matching", { triageContextPath: context });
    const capture = path.join(`${env.OPENCLAW_STATE_DIR}.update-captures`, "retained-run");
    await fs.mkdir(capture, { recursive: true });
    history.mockResolvedValue([run("retained-run", {})]);

    await expectFacts("retained-run", [directory, context, capture]);
  });

  it("correlates ledger drivers only by matching PID, start identity, and hostname", async () => {
    const driver = localDriver();
    history.mockResolvedValue([
      run("wrong-host", { driver: { ...driver, host: "other-host" } }),
      run("wrong-pid", { driver: { ...driver, pid: 1003 } }),
      run("wrong-start", { driver: { ...driver, startIdentity: "other-start" } }),
      run("matched-run", { previousDrivers: [localDriver(lease.helper)] }),
    ]);

    await expectFacts("matched-run", [lease.key], localDriver(lease.helper));
  });

  it.each([
    ["recovery", 4_000_000, 1_000, ["--timeout", "2"], 4_000_000],
    ["parent", 1_000, 5_000_000, ["--timeout", "2"], 5_000_000],
    ["command", 1_000, 2_000, ["node", "update", "--timeout", "8000", "--timeout=7200"], 8_000_000],
    ["invalid-duration", undefined, undefined, ["--timeout=9000.5", "--timeout", "Infinity"], null],
  ] as const)(
    "reads the recorded %s phase budget with the CLI timeout parser",
    async (name, recoveryTimeoutMs, parentExitTimeoutMs, commandArgv, expected) => {
      await helper(name, { recoveryTimeoutMs, parentExitTimeoutMs, commandArgv });
      history.mockResolvedValue([run("retained-run", {})]);
      expect((await readFacts()).timeoutMs).toBe(expected);
    },
  );

  it.each(["missing", "conflicting"])("refuses %s original run identity", async (identity) => {
    if (identity === "conflicting") {
      await helper("matching", { runId: "helper-run" });
      history.mockResolvedValue([run("ledger-run")]);
    }
    await expect(readFacts()).rejects.toThrow("Cannot identify handoff run");
  });

  it.each([false, true])(
    "preserves unresolved capture custody (generation-bound=%s)",
    async (bound) => {
      history.mockResolvedValue([
        run("captured-run", {
          ...(bound ? {} : { driver: localDriver() }),
          updateRecoveryCapture: {
            manifestSha256: "a".repeat(64),
            configWrites: [],
            status: "restore-failed",
          },
        }),
      ]);
      await expect(readFacts(bound ? "captured-run" : undefined)).rejects.toThrow(
        "retains restoration",
      );
      if (bound) {
        expect(listUpdateRunsAsync).toHaveBeenCalledWith(
          { limit: 100, includeRunId: "captured-run" },
          { env },
        );
      }
    },
  );

  it("preserves a native recovery owner's admission refusal", async () => {
    await helper("known-native");
    history.mockResolvedValue([run("retained-run", {})]);
    const refusal = new Error("Retained native recovery still owns its artifacts");
    vi.mocked(assertUpdateRecoveryAdmission).mockRejectedValueOnce(refusal);
    await expect(readFacts()).rejects.toBe(refusal);
  });

  it.each([
    [undefined, "failed", "failed", true, false],
    ["git rollback reset", "in_progress", "not-needed", true, false],
    ["global install rollback", "failed", "not-attempted", true, false],
    ["package rollback", "completed", undefined, true, false],
    ["config-rollback", "failed", "succeeded", true, false],
    ["git-runtime-rollback", "in_progress", undefined, true, false],
    ["git-rollback-source", "completed", undefined, true, false],
    ["previous generation restoration", "failed", undefined, true, false],
    ["package rollback", "completed", "succeeded", false, false],
    ["git rollback delete openclaw-update-fixture", "failed", "succeeded", false, false],
    ["git rollback checkout", "completed", undefined, false, true],
    ["package rollback", "skipped", undefined, false, false],
    ["rollback-outcome-recording", "failed", undefined, false, false],
    ["warning:package rollback", "failed", undefined, false, false],
    ["finalize:package-rollback-not-needed", "completed", undefined, false, false],
    ["git-rollback-keep-branch", "completed", undefined, false, false],
  ] as const)(
    "classifies legacy %s (%s, outcome=%s)",
    async (step, status, outcome, refuses, legacyCompleted) => {
      const original = run("legacy-rollback");
      if (step) {
        original.steps = [{ step, status }];
      }
      if (outcome) {
        original.verification.rollbackOutcome = { status: outcome, reason: "Historical rollback" };
      }
      if (legacyCompleted) {
        original.status = "rolled-back";
        original.verification.recovery = {
          serviceRestartSafe: true,
          packageRollbackVerified: true,
          service: "healthy",
          version: "1.0.0",
        };
      }
      history.mockResolvedValue([original]);
      if (refuses) {
        await expect(readFacts()).rejects.toThrow(/legacy-rollback.*rollback.*update status/u);
      } else {
        expect((await readFacts()).runIds).toEqual([original.runId]);
      }
    },
  );

  it.each(["restored", "retired", "forward"] as const)(
    "honors a %s capture receipt over stale rollback diagnostics",
    async (settlement) => {
      const original = run("settled-capture");
      original.verification.rollbackOutcome = { status: "failed", reason: "Old rollback" };
      original.steps = [{ step: "package rollback", status: "failed" }];
      const capture: NonNullable<UpdateRunRecord["origin"]["updateRecoveryCapture"]> = {
        manifestSha256: "a".repeat(64),
        configWrites: [],
        status: "pending",
      };
      if (settlement === "restored") {
        capture.restored = true;
      } else if (settlement === "retired") {
        capture.retirement = {
          directory: root,
          installRoot: root,
          stateDir: env.OPENCLAW_STATE_DIR!,
          configPath: path.join(root, "openclaw.json"),
          identity: { dev: 1, ino: 2, birthtimeMs: 3 },
          outcome: "restored",
        };
      } else {
        capture.forwardResolution = {
          kind: "forward-resolved",
          binding: {
            runId: original.runId,
            failedAtMs: 20,
            manifestSha256: capture.manifestSha256,
            candidateSha256: null,
            preparedSha256: null,
            installRoot: root,
            stateDir: env.OPENCLAW_STATE_DIR!,
            configPath: path.join(root, "openclaw.json"),
          },
          repair: {
            root,
            packageSha256: "b".repeat(64),
            node: process.execPath,
            nodeVersion: process.version,
            build: "settled-build",
            artifact: {
              rootIdentity: "settled-root",
              module: path.join(root, "module.mjs"),
              entry: path.join(root, "entry.mjs"),
              inventorySha256: "c".repeat(64),
              executableIdentity: "settled-node",
              executableSha256: "d".repeat(64),
            },
          },
          completedAtMs: 30,
        };
      }
      original.origin.updateRecoveryCapture = capture;
      history.mockResolvedValue([original]);
      expect((await readFacts()).runIds).toEqual([original.runId]);
    },
  );

  it.each(["rollback", "forward", "preparation-aborted"] as const)(
    "distinguishes native %s settlement from legacy rollback failure",
    async (settlement) => {
      const created = createUpdateRun({ trigger: "cli" }, { env });
      const original = run(created.runId);
      original.verification.rollbackOutcome = { status: "failed", reason: "Old rollback" };
      original.steps = [{ step: "package rollback", status: "failed" }];
      history.mockResolvedValue([original]);
      const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: "build" };
      const record = createRetainedUpdateRecovery(
        { runId: created.runId, from: runtime, to: runtime },
        { env },
      );
      if (settlement === "preparation-aborted") {
        record.claimKind = "recovery";
        record.revision = 4;
        record.preimages = { ...retainedCheckpointBinding(record), boundAtRevision: 0 };
        record.nativeManager = {
          identity: {
            platform: "linux",
            scope: "user",
            uid: 1000,
            unitName: "openclaw.service",
            runId: record.runId,
            stateDir: record.source!.stateDir,
            configPath: record.source!.configPath,
            profile: record.source!.profile!,
          },
          original: { exists: true, enabled: true, loaded: true, stopped: false },
          boundAtRevision: 0,
          effects: [],
        };
        record.package = retainedTerminalRecord(record).package!;
        record.package.descriptor.retention = null;
        Object.assign(record.package.observed.observation, {
          previous: "live",
          candidate: "staged",
        });
        record.primaryFailure = { code: "interrupted-preparation", effectId: null };
        record.preparationAborted = {
          reason: "interrupted-preparation",
          committedAtMs: record.updatedAtMs,
          commitRevision: record.revision,
          observedIdentity: record.package.observed.observedIdentity,
        };
        storeRetainedUpdateRecovery(record, { env });
        await expect(readFacts()).rejects.toThrow(/rollback/u);
      } else {
        storeRetainedUpdateRecovery(retainedTerminalRecord(record, settlement === "rollback"), {
          env,
        });
        expect((await readFacts()).runIds).toEqual([original.runId]);
      }
    },
  );

  it.each(["unreadable", "invalid-json", "invalid-owner"])(
    "keeps an %s helper directory and installation root in the census scope",
    async (kind) => {
      history.mockResolvedValue([run("retained-run")]);
      const directory = await helper(kind);
      const file = path.join(directory, "handoff.json");
      if (kind === "unreadable") {
        await fs.unlink(file);
      } else {
        await fs.writeFile(file, kind === "invalid-json" ? "{" : '{"updateLeaseOwner":123}');
      }
      await expectFacts("retained-run", [directory, lease.key], localDriver());
    },
  );
});
