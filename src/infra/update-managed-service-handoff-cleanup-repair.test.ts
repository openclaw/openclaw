import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";

vi.mock("./update-run-reader.js", () => ({ listUpdateRunsAsync: vi.fn() }));
vi.mock("./update-run-recovery-admission.js", () => ({ assertUpdateRecoveryAdmission: vi.fn() }));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
let root: string;
let env: NodeJS.ProcessEnv;
let lease: ManagedHandoffLease;

beforeEach(async () => {
  root = await fs.realpath(dirs.make("handoff-repair-facts-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  env = { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const payload = {
    version: 2 as const,
    executor: { pid: 1001, startIdentity: "executor-start" },
    helper: { pid: 1002, startIdentity: "helper-start" },
    action: {
      kind: "triage" as const,
      phase: "uncertain" as const,
      lifetime: {
        kind: "foreground" as const,
        boot: { platform: "linux" as const, identity: "01234567-89ab-cdef-0123-456789abcdef" },
      },
    },
  };
  lease = {
    ...payload,
    payload: JSON.stringify(payload),
    key: path.join(root, "installation"),
    owner: "handoff-correlation",
    updatedAt: 42,
  };
  vi.mocked(listUpdateRunsAsync).mockReset().mockResolvedValue([]);
  vi.mocked(assertUpdateRecoveryAdmission).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

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

function run(runId: string, origin: UpdateRunRecord["origin"]): UpdateRunRecord {
  return {
    runId,
    origin,
    target: {},
    before: {},
    after: {},
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: "update-failed",
    steps: [],
    verification: {},
    repair: [],
    createdAtMs: 10,
    updatedAtMs: 20,
    confirmedAtMs: null,
    finishedAtMs: 20,
    downtimeMs: null,
  };
}

describe("managed handoff repair facts", () => {
  it("keeps only exact helper owner/key artifacts and their retained capture paths", async () => {
    await helper("wrong-owner", { updateLeaseOwner: "other", runId: "other-run" });
    await helper("wrong-key", { updateLeaseKey: path.join(root, "other"), runId: "other-run" });
    const context = path.join(root, "failure.json");
    const directory = await helper("matching", {
      runId: "retained-run",
      triageContextPath: context,
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
    const capture = path.join(`${env.OPENCLAW_STATE_DIR}.update-captures`, "retained-run");
    await fs.mkdir(capture, { recursive: true });
    vi.mocked(listUpdateRunsAsync).mockResolvedValue([run("retained-run", {})]);

    expect(await readManagedHandoffRepairFacts(lease, env)).toEqual({
      runIds: ["retained-run"],
      artifactPaths: [directory, context, capture],
      timeoutMs: null,
    });
  });

  it("correlates ledger drivers only by matching PID, start identity, and hostname", async () => {
    const driver = { ...lease.executor, host: os.hostname() };
    vi.mocked(listUpdateRunsAsync).mockResolvedValue([
      run("wrong-host", { driver: { ...driver, host: "other-host" } }),
      run("wrong-pid", { driver: { ...driver, pid: 1003 } }),
      run("wrong-start", { driver: { ...driver, startIdentity: "other-start" } }),
      run("matched-run", { previousDrivers: [{ ...lease.helper, host: os.hostname() }] }),
    ]);

    expect(await readManagedHandoffRepairFacts(lease, env)).toEqual({
      runIds: ["matched-run"],
      artifactPaths: [lease.key],
      timeoutMs: null,
    });
  });

  it.each([
    {
      name: "recovery",
      recoveryTimeoutMs: 4_000_000,
      parentExitTimeoutMs: 1_000,
      commandArgv: ["--timeout", "2"],
      expected: 4_000_000,
    },
    {
      name: "parent",
      recoveryTimeoutMs: 1_000,
      parentExitTimeoutMs: 5_000_000,
      commandArgv: ["--timeout", "2"],
      expected: 5_000_000,
    },
    {
      name: "command",
      recoveryTimeoutMs: 1_000,
      parentExitTimeoutMs: 2_000,
      commandArgv: ["node", "update", "--timeout", "8000", "--timeout=7200"],
      expected: 8_000_000,
    },
    {
      name: "invalid-duration",
      commandArgv: ["--timeout=9000.5", "--timeout", "Infinity"],
      expected: null,
    },
  ])(
    "reads the recorded $name phase budget with the CLI timeout parser",
    async ({ name, expected, ...fields }) => {
      await helper(name, fields);
      vi.mocked(listUpdateRunsAsync).mockResolvedValue([run("retained-run", {})]);
      expect((await readManagedHandoffRepairFacts(lease, env)).timeoutMs).toBe(expected);
    },
  );

  it.each(["missing", "conflicting"])("refuses %s original run identity", async (identity) => {
    if (identity === "conflicting") {
      await helper("matching", { runId: "helper-run" });
      vi.mocked(listUpdateRunsAsync).mockResolvedValue([
        run("ledger-run", { driver: { ...lease.executor, host: os.hostname() } }),
      ]);
    }
    await expect(readManagedHandoffRepairFacts(lease, env)).rejects.toThrow(
      "Cannot identify handoff run",
    );
  });

  it.each([false, true])(
    "preserves unresolved capture custody (generation-bound=%s)",
    async (bound) => {
      vi.mocked(listUpdateRunsAsync).mockResolvedValue([
        run("captured-run", {
          ...(bound ? {} : { driver: { ...lease.executor, host: os.hostname() } }),
          updateRecoveryCapture: {
            manifestSha256: "a".repeat(64),
            configWrites: [],
            status: "restore-failed",
          },
        }),
      ]);
      await expect(
        readManagedHandoffRepairFacts(lease, env, bound ? "captured-run" : undefined),
      ).rejects.toThrow("retains restoration");
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
    vi.mocked(listUpdateRunsAsync).mockResolvedValue([run("retained-run", {})]);
    const refusal = new Error("Retained native recovery still owns its artifacts");
    vi.mocked(assertUpdateRecoveryAdmission).mockRejectedValueOnce(refusal);
    await expect(readManagedHandoffRepairFacts(lease, env)).rejects.toBe(refusal);
  });

  it.each<{
    name: string;
    step?: string;
    status?: UpdateRunRecord["steps"][number]["status"];
    outcome?: NonNullable<UpdateRunRecord["verification"]["rollbackOutcome"]>["status"];
    legacyCompleted?: boolean;
    refuses: boolean;
  }>([
    { name: "failed outcome without a step", outcome: "failed", refuses: true },
    {
      name: "in-progress Git rollback after an old no-op outcome",
      step: "git rollback reset",
      status: "in_progress",
      outcome: "not-needed",
      refuses: true,
    },
    {
      name: "failed package rollback after an old refusal",
      step: "global install rollback",
      status: "failed",
      outcome: "not-attempted",
      refuses: true,
    },
    {
      name: "package restored before config settlement",
      step: "package rollback",
      status: "completed",
      refuses: true,
    },
    {
      name: "failed config restoration after old success",
      step: "config-rollback",
      status: "failed",
      outcome: "succeeded",
      refuses: true,
    },
    {
      name: "in-progress runtime restoration",
      step: "git-runtime-rollback",
      status: "in_progress",
      refuses: true,
    },
    {
      name: "partial source restoration",
      step: "git-rollback-source",
      status: "completed",
      refuses: true,
    },
    {
      name: "unsettled previous generation",
      step: "previous generation restoration",
      status: "failed",
      refuses: true,
    },
    {
      name: "completed headless rollback",
      step: "package rollback",
      status: "completed",
      outcome: "succeeded",
      refuses: false,
    },
    {
      name: "completed Git rollback with failed temporary-branch cleanup",
      step: "git rollback delete openclaw-update-fixture",
      status: "failed",
      outcome: "succeeded",
      refuses: false,
    },
    {
      name: "legacy verified previous generation",
      step: "git rollback checkout",
      status: "completed",
      legacyCompleted: true,
      refuses: false,
    },
    { name: "skipped rollback", step: "package rollback", status: "skipped", refuses: false },
    {
      name: "outcome recording warning",
      step: "rollback-outcome-recording",
      status: "failed",
      refuses: false,
    },
    {
      name: "diagnostic rollback label",
      step: "warning:package rollback",
      status: "failed",
      refuses: false,
    },
    {
      name: "finalizer no-op",
      step: "finalize:package-rollback-not-needed",
      status: "completed",
      refuses: false,
    },
    {
      name: "retained Git branch",
      step: "git-rollback-keep-branch",
      status: "completed",
      refuses: false,
    },
  ])("classifies legacy rollback evidence: $name", async (scenario) => {
    const original = run("legacy-rollback", {
      driver: { ...lease.executor, host: os.hostname() },
    });
    if (scenario.step) {
      original.steps = [{ step: scenario.step, status: scenario.status! }];
    }
    if (scenario.outcome) {
      original.verification.rollbackOutcome = { status: scenario.outcome, reason: scenario.name };
    }
    if (scenario.legacyCompleted) {
      original.status = "rolled-back";
      original.verification.recovery = {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        service: "healthy",
        version: "1.0.0",
      };
    }
    vi.mocked(listUpdateRunsAsync).mockResolvedValue([original]);
    if (scenario.refuses) {
      await expect(readManagedHandoffRepairFacts(lease, env)).rejects.toThrow(
        /legacy-rollback.*rollback.*update status/u,
      );
    } else {
      expect((await readManagedHandoffRepairFacts(lease, env)).runIds).toEqual([original.runId]);
    }
  });

  it.each(["restored", "retired", "forward"] as const)(
    "honors a %s capture receipt over stale rollback diagnostics",
    async (settlement) => {
      const original = run("settled-capture", {
        driver: { ...lease.executor, host: os.hostname() },
      });
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
      vi.mocked(listUpdateRunsAsync).mockResolvedValue([original]);
      expect((await readManagedHandoffRepairFacts(lease, env)).runIds).toEqual([original.runId]);
    },
  );

  it.each(["rollback", "forward", "preparation-aborted"] as const)(
    "distinguishes native %s settlement from legacy rollback failure",
    async (settlement) => {
      const created = createUpdateRun({ trigger: "cli" }, { env });
      const original = run(created.runId, { driver: { ...lease.executor, host: os.hostname() } });
      original.verification.rollbackOutcome = { status: "failed", reason: "Old rollback" };
      original.steps = [{ step: "package rollback", status: "failed" }];
      vi.mocked(listUpdateRunsAsync).mockResolvedValue([original]);
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
        record.package.observed.observation = {
          previous: "live",
          candidate: "staged",
          launchers: "both",
          successorLive: false,
        };
        record.primaryFailure = { code: "interrupted-preparation", effectId: null };
        record.preparationAborted = {
          reason: "interrupted-preparation",
          committedAtMs: record.updatedAtMs,
          commitRevision: record.revision,
          observedIdentity: record.package.observed.observedIdentity,
        };
        storeRetainedUpdateRecovery(record, { env });
        await expect(readManagedHandoffRepairFacts(lease, env)).rejects.toThrow(/rollback/u);
      } else {
        storeRetainedUpdateRecovery(retainedTerminalRecord(record, settlement === "rollback"), {
          env,
        });
        expect((await readManagedHandoffRepairFacts(lease, env)).runIds).toEqual([original.runId]);
      }
    },
  );

  it.each(["unreadable", "invalid-json", "invalid-owner"])(
    "keeps an %s helper directory and installation root in the census scope",
    async (kind) => {
      vi.mocked(listUpdateRunsAsync).mockResolvedValue([
        run("retained-run", { driver: { ...lease.executor, host: os.hostname() } }),
      ]);
      const directory = await helper(kind);
      const file = path.join(directory, "handoff.json");
      if (kind === "unreadable") {
        await fs.unlink(file);
      } else {
        await fs.writeFile(file, kind === "invalid-json" ? "{" : '{"updateLeaseOwner":123}');
      }
      expect(await readManagedHandoffRepairFacts(lease, env)).toEqual({
        runIds: ["retained-run"],
        artifactPaths: [directory, lease.key],
        timeoutMs: null,
      });
    },
  );
});
