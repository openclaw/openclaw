import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { finalizeRestartUpdateRun } from "../../gateway/server-restart-update-run.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { captureSwap } from "../../infra/package-update-swap.assertions.test-support.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "../../infra/package-update-swap.test-support.js";
import { readRestartSentinel, readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as snapshot from "../../infra/sqlite-snapshot-source.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import type { UpdateCommandOptions } from "./shared.js";
import { readUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  resultFixture,
  stepFixture,
  verificationFixture,
} from "./update-command-fixtures.test-support.js";
import {
  finishSuccessfulPackageSwitch,
  mockVerifiedGatewayRun,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import * as service from "./update-command-service.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: async () => 19101,
}));

// Keep the finalizer, swap/completion, executor, SQLite lease, ledger, and both
// report consumers real. Unrelated plugin/native work has already succeeded.
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: async (params: { result: unknown }) => ({
    resultWithPostUpdate: params.result,
    postUpdateConfigSnapshot: validConfigSnapshot,
  }),
}));
vi.mock("./update-command-restart-context.js", () => ({
  prepareUpdateRestart: async () => ({ serviceMutationAllowed: false }),
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeRestartService: async () => "ok",
  tryInstallShellCompletion: async () => undefined,
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  tryWriteCompletionCache: async () => undefined,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let temporary: string;
let jsonOutput: unknown[];
let humanOutput: string[];
let errorOutput: string[];
beforeEach(async () => {
  vi.mocked(verifyUpdatedGateway).mockReset();
  base = await fs.realpath(dirs.make("update-terminal-outcome-"));
  temporary = path.join(base, "private-tmp");
  await fs.mkdir(temporary, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  jsonOutput = [];
  humanOutput = [];
  errorOutput = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    jsonOutput.push(structuredClone(value));
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
    humanOutput.push(String(value));
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
    humanOutput.push(String(value));
    errorOutput.push(String(value));
  });
});
afterEach(() => {
  vi.useRealTimers();
  __setFsSafeTestHooksForTest(undefined);
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function scenario(
  kind:
    | "healthy"
    | "retained"
    | "release-failure"
    | "revoked"
    | "foreign-revoked"
    | "link-retained"
    | "link-changed"
    | "transient-read"
    | "cleanup-deadline"
    | "verified-report-read"
    | "unverified-completion",
) {
  const json = kind !== "healthy";
  const repeat = kind === "retained" || kind === "cleanup-deadline";
  const deferred = kind !== "unverified-completion";
  const preparedRecovery = kind === "revoked" || kind === "link-retained";
  const completedByGateway = kind === "healthy" || kind === "release-failure";
  async function publishSwap(
    fixture: Awaited<ReturnType<typeof createPackageSwapFixture>>,
    expected: "committed" | "failed" = "committed",
  ) {
    const { result, transaction } = await captureSwap(fixture.params);
    expect(result.status).toBe(expected);
    return { ...fixture, result, transaction };
  }
  let swap;
  let setupInjected = false;
  if (kind === "unverified-completion") {
    const fixture = await createPackageSwapFixture(base);
    const rename = fs.rename.bind(fs);
    const effect = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.packageRoot) {
        setupInjected = true;
        throw Object.assign(new Error("fixture publication move denied"), { code: "EXDEV" });
      }
      return rename(...args);
    });
    try {
      swap = await publishSwap(fixture, "failed");
    } finally {
      effect.mockRestore();
    }
  } else if (["link-retained", "link-changed", "transient-read"].includes(kind)) {
    const fixture = await createPackageSwapFixture(base);
    const checkout = path.join(base, "operator-checkout");
    await fs.rename(fixture.packageRoot, checkout);
    await fs.symlink(
      checkout,
      fixture.packageRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    swap = await publishSwap(fixture);
  } else if (kind === "verified-report-read") {
    const fixture = await createPackageSwapFixture(base);
    const candidate = fixture.params.stage.packageRoot;
    const worker = path.join(candidate, "dist", "infra", "update-candidate-state.worker.js");
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await fs.writeFile(
      worker,
      `void import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState).href)});\n`,
    );
    await writePackageDistInventory(candidate);
    swap = await publishSwap(fixture);
  } else {
    swap = await createRetainedPackageSwap(base);
  }
  const cleanup =
    kind === "cleanup-deadline"
      ? {
          entered: createDeferredCore(),
          release: createDeferredCore(),
          clock: vi.spyOn(performance, "now").mockReturnValue(0),
        }
      : undefined;
  if (cleanup) {
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, target) {
        if (
          operation === "remove" &&
          target === path.join(swap.transaction.backupRoot, "package.json")
        ) {
          cleanup.entered.resolve();
          await cleanup.release.promise;
        }
      },
    });
  }
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
  const retainedState = async () => ({
    history: getUpdateRun(run.runId, { env: run.env }),
    sentinel: await readRestartSentinelReadOnly(run.env),
    reports: ["update-reports", path.join("logs", "support")].flatMap((relative) => {
      const directory = path.join(run.env!.OPENCLAW_STATE_DIR!, relative);
      return syncFs.existsSync(directory)
        ? syncFs
            .readdirSync(directory)
            .toSorted((left, right) => left.localeCompare(right))
            .map((name) => ({
              name: path.join(relative, name),
              bytes: syncFs.readFileSync(path.join(directory, name)),
            }))
        : [];
    }),
    lease: createManagedHandoffLeaseStore().read(swap.packageRoot),
  });
  let revokedState: Awaited<ReturnType<typeof retainedState>> | undefined;
  const verifiedState =
    kind === "verified-report-read"
      ? {
          schemaVersions: await readUpdateStateSchemaVersions({
            stateDir: path.join(base, "state"),
            config: {},
            env: run.env,
          }),
          activationConfig: await readUpdateConfigSnapshot(
            path.join(base, "state", "openclaw.json"),
          ),
        }
      : {};
  const rmdir = fs.rmdir.bind(fs);
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  const mutateLease = (sql: string) => {
    using db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
    db.exec(sql);
  };
  let injected = setupInjected;
  let failNextLeaseRead = false;
  let failNextStateRead = false;
  const lstat = syncFs.lstatSync.bind(syncFs);
  vi.spyOn(syncFs, "lstatSync").mockImplementation((...args) => {
    if (
      failNextStateRead &&
      String(args[0]) === path.join(base, "state", "state", "openclaw.sqlite")
    ) {
      failNextStateRead = false;
      injected = true;
      throw Object.assign(new Error("fixture update reporting identity read failed"), {
        code: "EIO",
      });
    }
    if (
      failNextLeaseRead &&
      String(args[0]) === path.join(temporary, "managed-update-handoffs.sqlite")
    ) {
      failNextLeaseRead = false;
      injected = true;
      throw Object.assign(new Error("fixture transient lease metadata read failure"), {
        code: "EIO",
      });
    }
    return lstat(...args);
  });
  if (kind === "link-changed") {
    const other = path.join(base, "replacement-checkout");
    await fs.mkdir(other);
    await unlink(swap.transaction.backupRoot);
    await fs.symlink(
      other,
      swap.transaction.backupRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    injected = true;
  }
  vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
    if (String(args[0]) === swap.transaction.backupRoot) {
      if (kind === "retained") {
        expect(await fs.readdir(swap.transaction.backupRoot)).toEqual([]);
        injected = true;
        throw Object.assign(new Error("fixture obsolete backup deletion denied"), {
          code: "EPERM",
        });
      }
      await rmdir(...args);
      if (kind === "revoked" || kind === "foreign-revoked") {
        injected = true;
        mutateLease("UPDATE managed_update_handoffs SET owner = 'replacement'");
        if (kind === "foreign-revoked") {
          finishUpdateRun(
            run.runId,
            { status: "failed", reason: "foreign-terminal-fact" },
            { env: run.env },
          );
        }
        revokedState = await retainedState();
      }
      return;
    }
    await rmdir(...args);
  });
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (kind === "retained" && String(args[0]) === swap.transaction.backupRoot) {
      throw Object.assign(new Error("fixture fallback rename denied"), { code: "EBUSY" });
    }
    return rename(...args);
  });
  vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
    if (kind === "link-retained" && String(args[0]) === swap.transaction.backupRoot) {
      injected = true;
      throw Object.assign(new Error("fixture obsolete link deletion denied"), { code: "EACCES" });
    }
    await unlink(...args);
    if (kind === "transient-read" && String(args[0]) === swap.transaction.backupRoot) {
      // The real lease owner next reads its real DB path once; its subsequent
      // reads recover. No executor or transaction method is replaced.
      failNextLeaseRead = true;
    }
  });
  let repeatedCompletion: UpdateStepResult | void = undefined;
  const observedResults: UpdateRunResult[] = [];
  const observationLeases: string[] = [];
  let failure: unknown;
  let reportSnapshotFailure: { mockRestore: () => void } | undefined;
  const execute = () =>
    withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(swap.packageRoot);
      if (completedByGateway) {
        recordUpdateRunVerification(run.runId, verificationFixture("2.0.0"), { env: run.env });
        finishUpdateRun(
          run.runId,
          { status: "succeeded", after: { version: "2.0.0" } },
          { env: run.env },
        );
      }
      if (kind === "verified-report-read") {
        vi.spyOn(service, "maybeRestartService").mockImplementationOnce(async ({ result }) => {
          const verification = verificationFixture("2.0.0");
          recordUpdateRunVerification(run.runId, verification, { env: run.env });
          result.verification = verification;
          closeOpenClawStateDatabaseForTest();
          failNextStateRead = true;
          return "ok";
        });
      }
      try {
        if (preparedRecovery) {
          mockVerifiedGatewayRun(run);
        }
        await finishSuccessfulPackageSwitch(
          { packageRoot: swap.packageRoot, run, json },
          {
            result: resultFixture(swap.packageRoot, {
              before: { version: "1.0.0" },
              after: { version: "2.0.0" },
              ...(preparedRecovery
                ? {
                    recovery: {
                      serviceRestartSafe: true as const,
                      packageRollbackVerified: true,
                      version: "2.0.0",
                      service: "healthy" as const,
                    },
                  }
                : {}),
              steps: preparedRecovery
                ? [
                    stepFixture("original update failure", {
                      command: "openclaw update",
                      cwd: swap.packageRoot,
                      durationMs: 1,
                      stderrTail: "fixture original failure before recovery",
                    }),
                  ]
                : [],
            }),
            packageTransaction: swap.transaction,
            ...verifiedState,
            ...(preparedRecovery ? { coreAlreadyCurrent: true } : {}),
            shouldRestart: false,
            installKindChanged: false,
            downgradeRisk: false,
          },
        );
      } finally {
        if (repeat) {
          try {
            repeatedCompletion = await swap.transaction.complete({ activationVerified: true }, () =>
              run.executorFence!.assertCurrent(),
            );
          } catch {
            // Failure is checked through the terminal outcome below.
          }
        }
      }
      if (kind === "release-failure") {
        injected = true;
        // A persistent trigger affects only this disposable lease database and
        // only the final DELETE. Acquisition and current-owner reads stay real.
        mutateLease(
          "CREATE TRIGGER deny_terminal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture final lease delete denied'); END",
        );
      }
    }).then(() => {
      if (completedByGateway) {
        closeOpenClawStateDatabaseForTest();
        reportSnapshotFailure = vi
          .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
          .mockImplementation(() => {
            throw new Error("live database changed during terminal publication");
          });
      }
    });
  try {
    const pending = deferred
      ? withUpdateCommandTerminalResult(
          (registerRun) => {
            registerRun(run);
            return execute();
          },
          {
            onResult: (result) => {
              observedResults.push(result);
              observationLeases.push(createManagedHandoffLeaseStore().read(swap.packageRoot).kind);
            },
          },
        )
      : execute();
    if (cleanup) {
      await cleanup.entered.promise;
      cleanup.clock.mockReturnValue(300_001);
      await Promise.resolve();
      expect(jsonOutput).toEqual([]);
      expect(createManagedHandoffLeaseStore().read(swap.packageRoot).kind).toBe("current");
      cleanup.release.resolve();
    }
    await pending;
  } catch (error) {
    failure = error;
  } finally {
    cleanup?.release.resolve();
    reportSnapshotFailure?.mockRestore();
  }
  if (
    (kind === "revoked" || kind === "foreign-revoked") &&
    failure instanceof UpdateCommandPendingRecoveryFailure
  ) {
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("fixture CLI exit");
    });
    await withUpdateFailureTriage(
      { json, yes: true, run },
      { root: swap.packageRoot, env: run.env },
      async () => {
        throw failure;
      },
    ).catch(() => undefined);
  }
  const expectedRetained = swap.transaction.backupRoot;
  const retainedExists = await fs.stat(expectedRetained).then(
    () => true,
    () => false,
  );
  const history = getUpdateRun(run.runId, { env: run.env });
  const report = history ? renderUpdateRunReport(history).markdown : "missing history";
  const observations = {
    injected,
    repeatedCompletion,
    exitCode: failure instanceof UpdateCommandFailure ? failure.exitCode : failure ? 1 : 0,
    failureObject: failure,
    revokedState,
    afterRevocation: revokedState ? await retainedState() : undefined,
    expectedRetained,
    retainedExists,
    package: JSON.parse(await fs.readFile(path.join(swap.packageRoot, "package.json"), "utf8")),
    launcher: await fs.readFile(swap.launcher, "utf8"),
    jsonOutput,
    observedResults,
    observationLeases,
    sentinel: preparedRecovery ? await readRestartSentinel(run.env) : undefined,
    humanOutput,
    errorOutput,
    history,
    report,
    lease: createManagedHandoffLeaseStore().read(swap.packageRoot).kind,
  };
  return observations;
}

describe("composed cleanup and terminal outcome", () => {
  it("keeps the verified candidate when its running update row cannot be read for reporting", async () => {
    const value = await scenario("verified-report-read");
    expect(value.injected).toBe(true);
    expect(value.package.version).toBe("2.0.0");
    expect(value.launcher).toBe("candidate launcher\n");
    expect(value.retainedExists).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.history?.status).not.toBe("succeeded");
    expect(value.history?.status).not.toBe("rolled-back");
  });
  it("publishes the Gateway's completed row after real executor release", async () => {
    const value = await scenario("healthy");
    expect(value).toMatchObject({ exitCode: 0, history: { status: "succeeded" } });
    expect(value.lease).toBe("absent");
    expect(value.retainedExists).toBe(false);
    expect(value.observedResults).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(value.observationLeases).toEqual(["absent"]);
    expect(value.humanOutput.join("\n").toLowerCase()).toContain("updated");
    expect(value.errorOutput).not.toContain(
      "Finishing update: checking package backup retention and cleanup.",
    );
  });
  it("suppresses prepared success when the real executor lease cannot be released", async () => {
    const value = await scenario("release-failure");
    expect(value.injected).toBe(true);
    expect(value).toMatchObject({ exitCode: 1, history: { status: "succeeded" } });
    expect(value.lease).toBe("current");
    expect(value.observedResults).toEqual([]);
    expect(value.jsonOutput).toEqual([]);
  });
  it("reports revoked authority from captured facts without changing retained state", async () => {
    const value = await scenario("revoked");
    expect(value.injected).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.failureObject).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    expect(value.jsonOutput).toEqual([expect.objectContaining({ status: "error" })]);
    expect(JSON.stringify(value.jsonOutput)).toContain("fixture original failure before recovery");
    expect(value.errorOutput.join("\n")).toContain("Update recovery remains pending");
    expect(value.observedResults).toEqual([]);
    expect(value.revokedState).toMatchObject({
      history: { status: "running" },
      lease: { kind: "current", lease: { owner: "replacement" } },
    });
    expect(value.afterRevocation).toEqual(value.revokedState);
    expect(value.package.version).toBe("2.0.0");
  });
  it("qualifies pending recovery claims after link-retained settlement", async () => {
    // Service verification is supplied data; publication, cleanup and owner failure are real.
    const value = await scenario("link-retained");
    const reason = "package-backup-retention-failed";
    expect(value.injected).toBe(true);
    expect(value).toMatchObject({ exitCode: 1, history: { status: "failed" } });
    expect(value.jsonOutput).toHaveLength(1);
    const report = value.jsonOutput[0];
    expect(report).toMatchObject({
      status: "error",
      reason,
      failedStep: {
        name: "package-backup-retention",
      },
    });
    expect(value.sentinel).toMatchObject({ payload: { status: "error", stats: { reason } } });
    expect(value.package.version).toBe("2.0.0");
    expect(value.report.toLowerCase()).toContain("failed");
    expect.soft(value.history?.downtimeMs).toBe(0);
    expect(JSON.stringify(report)).toContain("fixture original failure before recovery");
    expect(JSON.stringify(value.sentinel)).toContain("fixture original failure before recovery");
    expect(report).toMatchObject({
      recovery: {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        version: "2.0.0",
        service: "healthy",
      },
    });
    expect(value.sentinel?.payload.stats?.recovery).toEqual({
      serviceRestartSafe: true,
      version: "2.0.0",
      service: "healthy",
    });
    expect(value.retainedExists).toBe(true);
    expect(value.lease).toBe("absent");
  });

  it.each(["retained", "cleanup-deadline"] as const)(
    "reports the %s backup after verified activation and repeated completion",
    async (kind) => {
      const value = await scenario(kind);
      if (kind === "cleanup-deadline") {
        expect(value.repeatedCompletion).toMatchObject({
          durationMs: 300_001,
          advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
        });
        expect(value.report).toContain("cleanup budget expired");
        expect(
          await fs.readFile(path.join(value.expectedRetained, "package.json"), "utf8"),
        ).toContain('"version":"1.0.0"');
      } else {
        expect(value.injected).toBe(true);
      }
      expect(value.package.version).toBe("2.0.0");
      expect(value.launcher).toBe("candidate launcher\n");
      expect(value).toMatchObject({ exitCode: 0, history: { status: "succeeded" } });
      expect(value.retainedExists).toBe(true);
      expect(JSON.stringify(value.jsonOutput)).toContain(value.expectedRetained);
      expect(JSON.stringify(value.history)).toContain(value.expectedRetained);
      expect(value.report).toContain(value.expectedRetained);
      if (kind === "retained") {
        expect(value.report).toContain("EPERM");
        expect(value.report).toContain("EBUSY");
      }
      if (kind !== "cleanup-deadline") {
        expect(value.repeatedCompletion).toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining(value.expectedRetained),
        });
      }
    },
  );
  it.each(["link-changed", "transient-read"] as const)(
    "keeps producer-qualification failure hard for %s",
    async (kind) => {
      const value = await scenario(kind);
      expect(value.injected).toBe(true);
      expect(value).toMatchObject({ exitCode: 1, history: { status: "failed" } });
      expect(value.jsonOutput).toHaveLength(1);
      expect(value.jsonOutput[0]).toMatchObject({
        status: "error",
        steps: expect.not.arrayContaining([
          expect.objectContaining({ advisory: expect.anything() }),
        ]),
      });
    },
  );
  it("publishes the hard completion result through the direct finalizer fallback", async () => {
    const value = await scenario("unverified-completion");
    expect(value).toMatchObject({ exitCode: 1, history: { status: "failed" } });
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
  });
  it("preserves foreign terminal history and emits only the pending failure", async () => {
    const value = await scenario("foreign-revoked");
    expect(value.injected).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.history).toMatchObject({ status: "failed", reason: "foreign-terminal-fact" });
  });
});

it("keeps foreground success pending until the replacement Gateway observes the final sentinel", async () => {
  const swap = await createRetainedPackageSwap(base);
  const root = swap.packageRoot;
  await writePackageRoot(root, VERSION);
  const backupManifest = path.join(swap.transaction.backupRoot, "package.json");
  const backupBytes = await fs.readFile(backupManifest);
  const complete = vi.spyOn(swap.transaction, "complete");
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "api" }, { env: process.env }).runId,
    env: { ...process.env },
    completionOwner: "gateway-restart",
    gatewayRestartRequired: true,
  };
  const meta = { runId: run.runId, completionOwner: "gateway-restart" as const };
  await withUpdateCommandTerminalResult(async (registerRun) => {
    registerRun(run);
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(root);
      await finishSuccessfulPackageSwitch(
        { packageRoot: root, run, json: true },
        {
          packageTransaction: swap.transaction,
          shouldRestart: false,
          installKindChanged: false,
          downgradeRisk: false,
          controlPlaneUpdateSentinelMeta: meta,
          result: resultFixture(root, {
            mode: "git",
            before: { version: "1.0.0", sha: "aaa" },
            after: { version: VERSION, sha: "bbb" },
          }),
        },
      );
    });
  });
  expect(complete).not.toHaveBeenCalled();
  expect(await fs.readFile(backupManifest)).toEqual(backupBytes);
  expect(jsonOutput).toHaveLength(1);
  expect(jsonOutput[0]).toMatchObject({ runId: run.runId, status: "ok" });
  expect(getUpdateRun(run.runId)).toMatchObject({
    trigger: "api",
    status: "running",
    phase: "restarting",
    after: { version: VERSION },
  });
  const finalSentinel = await readRestartSentinel();
  expect(finalSentinel?.payload).toMatchObject({
    kind: "update",
    status: "ok",
    stats: { runId: run.runId },
  });
  expect(finalSentinel?.payload.stats?.handoffId).toBeUndefined();
  if (!finalSentinel) {
    throw new Error("Expected the canonical final sentinel");
  }
  setRuntimeConfigSnapshot(validConfigSnapshot.runtimeConfig);
  await finalizeRestartUpdateRun(finalSentinel.payload);
  expect(getUpdateRun(run.runId)).toMatchObject({
    status: "succeeded",
    verification: { booted: true, serviceRunning: true, versionMatch: true },
  });
});
