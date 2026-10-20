import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { packageActivationRuntimeForTest } from "../../infra/package-update-activation-runtime.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as snapshot from "../../infra/sqlite-snapshot-source.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as sentinel from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  requestUpdateCommandExecutorCancellation,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UnreportedUpdateAdmissionOutcome,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import {
  hasDeferredUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: async () => 19101,
}));

// Keep the finalizer, swap/completion, executor, SQLite lease, ledger, and both
// report consumers real. Unrelated plugin/native work has already succeeded.
vi.mock("./update-command-convergence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-convergence.js")>()),
  convergeUpdatePlugins: async (params: { result: unknown }) => ({
    resultWithPostUpdate: params.result,
    postUpdateConfigSnapshot: validConfigSnapshot,
  }),
}));
vi.mock("./update-command-restart-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-restart-context.js")>()),
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

async function journaledFixture(root: string) {
  const fixture = await createPackageSwapFixture(root);
  const worker = path.join(
    fixture.params.stage.packageRoot,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  // Exercise the candidate's real capability probe through the compiled test closure.
  await fs.writeFile(
    worker,
    `import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize).href)});\n`,
  );
  await writePackageDistInventory(fixture.params.stage.packageRoot);
  return fixture;
}

it.skipIf(process.platform === "win32").each([
  { cancel: false, captured: false },
  { cancel: false, captured: true },
  { cancel: true, captured: false },
])(
  "retains terminal authority until release (cancel: $cancel, captured: $captured)",
  async ({ cancel, captured }) => {
    const fixture = await journaledFixture(base);
    const next = await journaledFixture(path.join(base, "next"));
    const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
      env: { ...process.env },
    };
    const onResult = vi.fn();
    const notification = createDeferredCore();
    const resumeNotification = createDeferredCore();
    const cancellation = new Error("fixture cancellation during terminal preparation");
    const rename = vi.spyOn(fs, "rename");
    let postReleaseRenames = 0;
    let postReleaseRead: { mockRestore: () => void } | undefined;
    const writeSentinel = sentinel.writeControlPlaneUpdateRestartSentinel;
    let before:
      | {
          sentinel: Awaited<ReturnType<typeof readRestartSentinelReadOnly>>;
          run: ReturnType<typeof getUpdateRun>;
          leaseKind: string;
          originalJournalRetired: boolean;
        }
      | undefined;
    let afterRelease:
      | {
          run: ReturnType<typeof getUpdateRun>;
          journal: Buffer;
          report: string | undefined;
        }
      | undefined;
    let injectionFailure: unknown;
    let injected = false;
    let contenderFailure: unknown;
    const publishNext = () =>
      withUpdateCommandExecutor("next-update", async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        const published = await swapStagedPackageInstall({
          ...next.params,
          installTarget: fixture.params.installTarget,
          activation: {
            fence,
            runtime: packageActivationRuntimeForTest(),
            onPrepared: () => {},
          },
          onTransaction: () => {},
        });
        expect(published.status, published.step.stderrTail ?? "").toBe("committed");
      });
    vi.spyOn(sentinel, "writeControlPlaneUpdateRestartSentinel").mockImplementation(
      async (...args) => {
        await writeSentinel(...args);
        if (injected || args[0].result.status !== "ok") {
          return;
        }
        injected = true;
        // The original journal is retired, but terminal state still belongs to
        // the original executor. A second real swap must not acquire this slot yet.
        try {
          before = {
            sentinel: await readRestartSentinelReadOnly(run.env),
            run: getUpdateRun(run.runId, { env: run.env }),
            leaseKind: createManagedHandoffLeaseStore().read(fixture.packageRoot).kind,
            originalJournalRetired: !syncFs.existsSync(anchor),
          };
          await publishNext().catch((error: unknown) => {
            contenderFailure = error;
          });
        } catch (error) {
          // Sentinel notification is best-effort; surface fixture failures outside that catch.
          injectionFailure = error;
        }
        notification.resolve();
        await resumeNotification.promise;
      },
    );
    let failure: unknown;
    const work = withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        let operationFailure: unknown;
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          const fence = await executor.enter(fixture.packageRoot);
          run.executorFence = fence;
          let transaction: PackageUpdateTransaction | undefined;
          const published = await swapStagedPackageInstall({
            ...fixture.params,
            activation: {
              fence,
              runtime: packageActivationRuntimeForTest(),
              onPrepared: () => {},
            },
            onTransaction: (value) => {
              transaction = value;
            },
          });
          expect(published.status, published.step.stderrTail ?? "").toBe("committed");
          expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
          expect(transaction).toBeDefined();
          if (captured) {
            recordUpdateRunVerification(
              run.runId,
              {
                serviceRunning: true,
                versionMatch: true,
                channelsReady: true,
                readyz: true,
                settled: true,
                runningVersion: "2.0.0",
                pluginErrors: [],
              },
              { env: run.env },
            );
            finishUpdateRun(
              run.runId,
              {
                status: "succeeded",
                after: { version: "2.0.0" },
              },
              { env: run.env },
            );
          }
          await finishSuccessfulPackageSwitch(
            { packageRoot: fixture.packageRoot, run, json: true },
            {
              packageTransaction: transaction,
              shouldRestart: false,
              installKindChanged: false,
              downgradeRisk: false,
              ...(captured
                ? {
                    result: {
                      status: "ok" as const,
                      mode: "npm" as const,
                      root: fixture.packageRoot,
                      after: { version: "2.0.0" },
                      steps: [],
                      durationMs: 1,
                    },
                  }
                : {}),
              controlPlaneUpdateSentinelMeta: { runId: run.runId, note: "requested update" },
            },
          );
        }).catch((error: unknown) => {
          operationFailure = error;
        });
        expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
        expect(jsonOutput).toEqual([]);
        expect(onResult).not.toHaveBeenCalled();
        // A real successor is now admitted before the outer publisher emits.
        // It must not cause that publisher to re-read or mutate the old run.
        await publishNext();
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
        const reportPath = path.join(
          run.env!.OPENCLAW_STATE_DIR!,
          "update-reports",
          `${run.runId}.md`,
        );
        afterRelease = {
          run: getUpdateRun(run.runId, { env: run.env }),
          journal: syncFs.readFileSync(resolvePackageActivationJournalPath(anchor)),
          report: syncFs.existsSync(reportPath)
            ? syncFs.readFileSync(reportPath, "utf8")
            : undefined,
        };
        postReleaseRenames = rename.mock.calls.length;
        closeOpenClawStateDatabaseForTest();
        postReleaseRead = vi
          .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
          .mockImplementation(() => {
            throw new Error("released terminal publication cannot reopen history");
          });
        if (operationFailure !== undefined) {
          assert(operationFailure instanceof Error);
          throw operationFailure;
        }
      },
      { json: true, onResult },
    )
      .catch((error: unknown) => {
        failure = error;
        notification.reject(error);
      })
      .finally(() => notification.resolve());
    try {
      await notification.promise;
      expect(injectionFailure).toBeUndefined();
      expect(contenderFailure).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(onResult).not.toHaveBeenCalled();
      expect(jsonOutput).toEqual([]);
      if (cancel) {
        requestUpdateCommandExecutorCancellation(run.executorFence!, run.runId, cancellation);
        let cancelledContender: unknown;
        await publishNext().catch((error: unknown) => {
          cancelledContender = error;
        });
        expect(cancelledContender).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      }
    } finally {
      resumeNotification.resolve();
      await work;
      postReleaseRead?.mockRestore();
    }
    expect(injectionFailure).toBeUndefined();
    expect(injected).toBe(true);
    expect(before).toMatchObject({
      sentinel: { payload: { status: "ok", stats: { runId: run.runId } } },
      // The uncaptured row must remain running until the notification returns.
      run: { status: captured ? "succeeded" : "running" },
      leaseKind: "current",
      originalJournalRetired: true,
    });
    if (cancel) {
      expect(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
      expect(collectNestedErrorCandidates(failure)).toContain(cancellation);
      expect(onResult).not.toHaveBeenCalled();
      expect(jsonOutput).toEqual([]);
      expect(afterRelease?.run).toEqual(before?.run);
      expect(afterRelease?.report).toBeUndefined();
    } else {
      expect(failure).toBeUndefined();
      expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "ok" }));
      expect(jsonOutput).toEqual([expect.objectContaining({ status: "ok" })]);
      expect(afterRelease?.run?.status).toBe("succeeded");
      expect(afterRelease?.report).toBeDefined();
    }
    expect(getUpdateRun(run.runId, { env: run.env })).toEqual(afterRelease?.run);
    expect(rename.mock.calls).toHaveLength(postReleaseRenames);
    expect(await readRestartSentinelReadOnly(run.env)).toEqual(before?.sentinel);
    expect(syncFs.readFileSync(resolvePackageActivationJournalPath(anchor))).toEqual(
      afterRelease?.journal,
    );
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "timeout",
    "unprepared-admission",
    "prepared-admission",
    "prepared-child-failure",
  ] as const)("preserves terminal facts when a successor follows %s", async (kind) => {
  const prepared = kind === "prepared-admission" || kind === "prepared-child-failure";
  const childFailure = new Error("fixture completed child settlement failure");
  const fixture = await journaledFixture(base);
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
  const original = getUpdateRun(run.runId, { env: run.env });
  const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
  const onResult = vi.fn();
  const reportPath = path.join(run.env!.OPENCLAW_STATE_DIR!, "update-reports", `${run.runId}.md`);
  let originalFailure: unknown;
  let journal: Buffer | undefined;
  let settledRecord: ReturnType<typeof getUpdateRun>;
  let preparedReport: string | undefined;
  let postReleaseRead: { mockRestore: () => void } | undefined;
  let failure: unknown;
  try {
    await withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(fixture.packageRoot, {
            preflight: true,
            ...(kind === "timeout" ? { activationTimeoutMs: 60_000 } : {}),
          });
          if (kind === "timeout") {
            // Expire synchronous work before a finalizer can register, without
            // dispatching a timer or permitting another updater before release.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.now() + 60_001);
            run.executorFence.assertCurrent();
            throw new Error("The activation deadline did not revoke its owner");
          }
          const refused = new UnreportedUpdateAdmissionOutcome(
            {
              opts: { run, json: true },
              root: fixture.packageRoot,
              installKind: "package",
              reason: "fixture-preflight-refusal",
              message: "Package manager admission refused",
              controlPlaneUpdateSentinelMeta: null,
            },
            { exitCode: 0 },
          );
          if (prepared) {
            if (kind === "prepared-child-failure") {
              // The child has already joined, so admission is idle; its real
              // settlement error is collected after refusal preparation registers.
              await expect(
                withUpdateCommandExecutorChild(run.executorFence, fixture.packageRoot, async () => {
                  throw childFailure;
                }),
              ).rejects.toBe(childFailure);
              run.executorFence.assertCurrent();
            }
            return await withUpdateCommandRecoveryUnwind(
              { run, json: true },
              { triageTarget: { root: fixture.packageRoot, env: run.env! } },
              async () => {
                throw refused;
              },
            ).catch((error: unknown) => {
              expect(hasDeferredUpdateCommandTerminalResult(run)).toBe(true);
              throw error;
            });
          }
          throw refused;
        }).catch((error: unknown) => {
          originalFailure = error;
        });
        vi.useRealTimers();
        expect(originalFailure).toBeInstanceOf(
          kind === "timeout"
            ? UpdateActivationTimeoutError
            : kind === "prepared-child-failure"
              ? AggregateError
              : prepared
                ? UpdateCommandFailure
                : UnreportedUpdateAdmissionOutcome,
        );
        expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
        expect(jsonOutput).toEqual([]);
        expect(onResult).not.toHaveBeenCalled();
        settledRecord = getUpdateRun(run.runId, { env: run.env });
        if (prepared) {
          expect(settledRecord).toMatchObject({
            status: kind === "prepared-child-failure" ? "failed" : "skipped",
            reason:
              kind === "prepared-child-failure"
                ? "update-admission-cleanup-failed"
                : "fixture-preflight-refusal",
          });
          preparedReport = syncFs.readFileSync(reportPath, "utf8");
          if (kind === "prepared-child-failure") {
            expect(collectNestedErrorCandidates(originalFailure)).toContain(childFailure);
            expect(preparedReport).toContain("Package manager admission refused");
            expect(preparedReport).toContain(childFailure.message);
          }
        } else {
          expect(settledRecord).toEqual(original);
        }
        await withUpdateCommandExecutor("successor-update", async (executor) => {
          const fence = await executor.enter(fixture.packageRoot);
          const published = await swapStagedPackageInstall({
            ...fixture.params,
            activation: {
              fence,
              runtime: packageActivationRuntimeForTest(),
              onPrepared: () => {},
            },
            onTransaction: () => {},
          });
          expect(published.status, published.step.stderrTail ?? "").toBe("committed");
        });
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
        journal = syncFs.readFileSync(resolvePackageActivationJournalPath(anchor));
        closeOpenClawStateDatabaseForTest();
        postReleaseRead = vi.spyOn(snapshot, "prepareSqliteReadOnlyLocationSync");
        throw originalFailure;
      },
      { json: true, onResult },
    );
  } catch (error) {
    failure = error;
  } finally {
    vi.useRealTimers();
  }
  expect(journal).toBeDefined();
  if (prepared) {
    expect(failure).toBeInstanceOf(UpdateCommandFailure);
    expect(failure).not.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    const status = kind === "prepared-child-failure" ? "error" : "skipped";
    const reason =
      kind === "prepared-child-failure"
        ? "update-admission-cleanup-failed"
        : "fixture-preflight-refusal";
    expect(failure).toMatchObject({
      exitCode: kind === "prepared-child-failure" ? 1 : 0,
      result: { status, reason },
    });
    expect(jsonOutput).toHaveLength(1);
    expect(jsonOutput[0]).toMatchObject({ status, reason });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status, reason }));
    expect(syncFs.readFileSync(reportPath, "utf8")).toBe(preparedReport);
  } else {
    expect(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    expect(failure).toMatchObject({
      cause: originalFailure,
      result: {
        reason: kind === "timeout" ? "update-activation-timeout" : "fixture-preflight-refusal",
      },
    });
    expect(syncFs.existsSync(reportPath)).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
    expect(jsonOutput).toEqual([]);
  }
  expect(postReleaseRead).not.toHaveBeenCalled();
  postReleaseRead?.mockRestore();
  expect(getUpdateRun(run.runId, { env: run.env })).toEqual(settledRecord);
  expect(syncFs.readFileSync(resolvePackageActivationJournalPath(anchor))).toEqual(journal);
  expect(await readRestartSentinelReadOnly(run.env)).toBeNull();
});
