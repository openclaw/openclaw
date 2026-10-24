import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as activationJournal from "../../infra/package-update-activation-journal.js";
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
import * as ledger from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  requestUpdateCommandExecutorCancellation as cancelExecutor,
  withUpdateCommandExecutor as withExecutor,
  withUpdateCommandExecutorChild as withChild,
} from "./update-command-executor.js";
import { verificationFixture } from "./update-command-fixtures.test-support.js";
import { updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import * as results from "./update-command-result.js";
import {
  hasDeferredUpdateCommandTerminalResult as hasDeferredResult,
  withUpdateCommandTerminalResult as withTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: async () => 19101,
}));

// Only unrelated plugin/native work is mocked; terminal state stays real.
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
let jsonOutput: unknown[];
beforeEach(async () => {
  vi.mocked(verifyUpdatedGateway).mockReset();
  base = await fs.realpath(dirs.make("update-terminal-outcome-"));
  const temporary = path.join(base, "private-tmp");
  await fs.mkdir(temporary, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  jsonOutput = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    jsonOutput.push(structuredClone(value));
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
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

type Run = NonNullable<UpdateCommandOptions["run"]>;
type Fixture = Awaited<ReturnType<typeof journaledFixture>>;
function createRun(): Run {
  return {
    runId: ledger.createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
}
function reportPath(run: Run) {
  return path.join(run.env!.OPENCLAW_STATE_DIR!, "update-reports", `${run.runId}.md`);
}
function expectUnpublished(onResult: ReturnType<typeof vi.fn>) {
  expect(jsonOutput).toEqual([]);
  expect(onResult).not.toHaveBeenCalled();
}
async function publishPackage(
  fixture: Fixture,
  fence: NonNullable<Run["executorFence"]>,
  installTarget = fixture.params.installTarget,
) {
  let transaction: PackageUpdateTransaction | undefined;
  const published = await swapStagedPackageInstall({
    ...fixture.params,
    installTarget,
    activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
    onTransaction: (value) => {
      transaction = value;
    },
  });
  expect(published.status, published.step.stderrTail ?? "").toBe("committed");
  return transaction;
}
function readRun(run: Run) {
  return ledger.getUpdateRun(run.runId, { env: run.env });
}
function readJournal(anchor: string) {
  return syncFs.readFileSync(activationJournal.resolvePackageActivationJournalPath(anchor));
}
function expectPublication(anchor: string) {
  expect(activationJournal.openPackageActivationJournal(anchor).read().phase).toBe(
    "publication-complete",
  );
}
function readReport(run: Run) {
  return syncFs.readFileSync(reportPath(run), "utf8");
}
function beforeRelease(
  run: Run,
  fixture: Fixture,
  anchor: string,
  restartSentinel: Awaited<ReturnType<typeof readRestartSentinelReadOnly>>,
) {
  return {
    sentinel: restartSentinel,
    run: readRun(run),
    leaseKind: createManagedHandoffLeaseStore().read(fixture.packageRoot).kind,
    originalJournalRetired: !syncFs.existsSync(anchor),
  };
}
function releasedState(run: Run, anchor: string) {
  return {
    run: readRun(run),
    journal: readJournal(anchor),
    report: syncFs.existsSync(reportPath(run)) ? readReport(run) : undefined,
  };
}
function expectPublished(onResult: ReturnType<typeof vi.fn>, result: object) {
  expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(result));
  expect(jsonOutput).toEqual([expect.objectContaining(result)]);
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
    const anchor = activationJournal.resolvePackageActivationAnchor(fixture.packageRoot);
    const run = createRun();
    const onResult = vi.fn();
    const notification = createDeferredCore();
    const resumeNotification = createDeferredCore();
    const cancellation = new Error("fixture cancellation during terminal preparation");
    const rename = vi.spyOn(fs, "rename");
    let postReleaseRenames = 0;
    let postReleaseRead: { mockRestore: () => void } | undefined;
    const postReleaseReadOwners: Array<string | undefined> = [];
    const writeSentinel = sentinel.writeControlPlaneUpdateRestartSentinel;
    let before: ReturnType<typeof beforeRelease> | undefined;
    let afterRelease: ReturnType<typeof releasedState> | undefined;
    let injectionFailure: unknown;
    let injected = false;
    let contenderFailure: unknown;
    const publishNext = () =>
      withExecutor("next-update", async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        await publishPackage(next, fence, fixture.params.installTarget);
      });
    vi.spyOn(sentinel, "writeControlPlaneUpdateRestartSentinel").mockImplementation(
      async (...args) => {
        await writeSentinel(...args);
        if (injected || args[0].result.status !== "ok") {
          return;
        }
        injected = true;
        // Retiring the journal must not admit a successor before terminal release.
        try {
          before = beforeRelease(run, fixture, anchor, await readRestartSentinelReadOnly(run.env));
          contenderFailure = await publishNext().catch((error: unknown) => error);
        } catch (error) {
          // Sentinel notification is best-effort; surface fixture failures outside that catch.
          injectionFailure = error;
        }
        notification.resolve();
        await resumeNotification.promise;
      },
    );
    let failure: unknown;
    const work = withTerminalResult(
      async (registerRun) => {
        registerRun(run);
        const operationFailure = await withExecutor(run.runId, async (executor) => {
          const fence = await executor.enter(fixture.packageRoot);
          run.executorFence = fence;
          const transaction = await publishPackage(fixture, fence);
          expectPublication(anchor);
          expect(transaction).toBeDefined();
          if (captured) {
            ledger.recordUpdateRunVerification(run.runId, verificationFixture("2.0.0"), {
              env: run.env,
            });
            ledger.finishUpdateRun(
              run.runId,
              { status: "succeeded", after: { version: "2.0.0" } },
              {
                env: run.env,
              },
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
                    result: updateResult({
                      root: fixture.packageRoot,
                      after: { version: "2.0.0" },
                    }),
                  }
                : {}),
              controlPlaneUpdateSentinelMeta: { runId: run.runId, note: "requested update" },
            },
          );
        }).catch((error: unknown) => error);
        expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
        expectUnpublished(onResult);
        // Publication cannot reuse released update authority after a successor.
        // Optional cleanup must acquire its own state custody and only add diagnostics.
        await publishNext();
        expectPublication(anchor);
        afterRelease = releasedState(run, anchor);
        postReleaseRenames = rename.mock.calls.length;
        closeOpenClawStateDatabaseForTest();
        postReleaseRead = vi
          .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
          .mockImplementation(() => {
            postReleaseReadOwners.push(
              captureGatewayStateOwner(
                path.join(run.env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"),
              )?.role,
            );
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
      expectUnpublished(onResult);
      if (cancel) {
        cancelExecutor(run.executorFence!, run.runId, cancellation);
        const cancelledContender = await publishNext().catch((error: unknown) => error);
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
      run: { status: captured ? "succeeded" : "running" },
      leaseKind: "current",
      originalJournalRetired: true,
    });
    if (cancel) {
      expect(failure).toBeInstanceOf(results.UpdateCommandPendingRecoveryFailure);
      expect(collectNestedErrorCandidates(failure)).toContain(cancellation);
      expectUnpublished(onResult);
      expect(afterRelease?.run).toEqual(before?.run);
      expect(afterRelease?.report).toBeUndefined();
    } else {
      expect(failure).toBeUndefined();
      expectPublished(onResult, { status: "ok" });
      expect(afterRelease?.run?.status).toBe("succeeded");
      expect(afterRelease?.report).toBeDefined();
    }
    const recorded = readRun(run);
    if (cancel) {
      expect(recorded).toEqual(afterRelease?.run);
      expect(postReleaseReadOwners).toEqual([]);
    } else {
      assert(recorded && afterRelease?.run);
      expect(postReleaseReadOwners.length).toBeGreaterThan(0);
      expect(postReleaseReadOwners.every((role) => role === "agent-embedded")).toBe(true);
      const cleanupSteps = new Set([
        "recovery-artifact-cleanup",
        "warning:recovery-artifact-cleanup",
      ]);
      expect({
        ...recorded,
        updatedAtMs: afterRelease.run.updatedAtMs,
        steps: recorded.steps.filter((step) => !cleanupSteps.has(step.step)),
      }).toEqual(afterRelease.run);
      expect(recorded.steps).toContainEqual(
        expect.objectContaining({
          step: "warning:recovery-artifact-cleanup",
          status: "completed",
          detail: expect.stringContaining("released terminal publication cannot reopen history"),
        }),
      );
    }
    expect(rename.mock.calls).toHaveLength(postReleaseRenames);
    expect(await readRestartSentinelReadOnly(run.env)).toEqual(before?.sentinel);
    expect(readJournal(anchor)).toEqual(afterRelease?.journal);
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
  const childFailed = kind === "prepared-child-failure";
  const prepared = kind === "prepared-admission" || childFailed;
  const reason = childFailed ? "update-admission-cleanup-failed" : "fixture-preflight-refusal";
  const childFailure = new Error("fixture completed child settlement failure");
  const fixture = await journaledFixture(base);
  const run = createRun();
  const original = readRun(run);
  const anchor = activationJournal.resolvePackageActivationAnchor(fixture.packageRoot);
  const onResult = vi.fn();
  let originalFailure: unknown;
  let journal: Buffer | undefined;
  let settledRecord: ReturnType<typeof readRun>;
  let preparedReport: string | undefined;
  let postReleaseRead: { mockRestore: () => void } | undefined;
  const failure = await withTerminalResult(
    async (registerRun) => {
      registerRun(run);
      originalFailure = await withExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(fixture.packageRoot, {
          preflight: true,
          ...(kind === "timeout" ? { activationTimeoutMs: 60_000 } : {}),
        });
        if (kind === "timeout") {
          // Expire the owner synchronously, without dispatching its timer.
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.spyOn(performance, "now").mockImplementation(() => Date.now());
          vi.setSystemTime(Date.now() + 60_001);
          run.executorFence.assertCurrent();
          throw new Error("The activation deadline did not revoke its owner");
        }
        const refused = new results.UnreportedUpdateAdmissionOutcome(
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
          if (childFailed) {
            // Join before refusal; retain the settlement error for terminal preparation.
            await expect(
              withChild(run.executorFence, fixture.packageRoot, async () => {
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
            expect(hasDeferredResult(run)).toBe(true);
            throw error;
          });
        }
        throw refused;
      }).catch((error: unknown) => error);
      vi.useRealTimers();
      expect(originalFailure).toBeInstanceOf(
        kind === "timeout"
          ? UpdateActivationTimeoutError
          : childFailed
            ? AggregateError
            : prepared
              ? results.UpdateCommandFailure
              : results.UnreportedUpdateAdmissionOutcome,
      );
      expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
      expectUnpublished(onResult);
      settledRecord = readRun(run);
      if (prepared) {
        expect(settledRecord).toMatchObject({
          status: childFailed ? "failed" : "skipped",
          reason,
        });
        preparedReport = readReport(run);
        if (childFailed) {
          expect(collectNestedErrorCandidates(originalFailure)).toContain(childFailure);
          expect(preparedReport).toContain("Package manager admission refused");
          expect(preparedReport).toContain(childFailure.message);
        }
      } else {
        expect(settledRecord).toEqual(original);
      }
      await withExecutor("successor-update", async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        await publishPackage(fixture, fence);
      });
      expectPublication(anchor);
      journal = readJournal(anchor);
      closeOpenClawStateDatabaseForTest();
      postReleaseRead = vi.spyOn(snapshot, "prepareSqliteReadOnlyLocationSync");
      throw originalFailure;
    },
    { json: true, onResult },
  )
    .catch((error: unknown) => error)
    .finally(() => vi.useRealTimers());
  expect(journal).toBeDefined();
  if (prepared) {
    expect(failure).toBeInstanceOf(results.UpdateCommandFailure);
    expect(failure).not.toBeInstanceOf(results.UpdateCommandPendingRecoveryFailure);
    const status = childFailed ? "error" : "skipped";
    expect(failure).toMatchObject({
      exitCode: childFailed ? 1 : 0,
      result: { status, reason },
    });
    expectPublished(onResult, { status, reason });
    expect(readReport(run)).toBe(preparedReport);
  } else {
    expect(failure).toBeInstanceOf(results.UpdateCommandPendingRecoveryFailure);
    expect(failure).toMatchObject({
      cause: originalFailure,
      result: {
        reason: kind === "timeout" ? "update-activation-timeout" : "fixture-preflight-refusal",
      },
    });
    expect(syncFs.existsSync(reportPath(run))).toBe(false);
    expectUnpublished(onResult);
  }
  expect(postReleaseRead).not.toHaveBeenCalled();
  postReleaseRead?.mockRestore();
  expect(readRun(run)).toEqual(settledRecord);
  expect(readJournal(anchor)).toEqual(journal);
  expect(await readRestartSentinelReadOnly(run.env)).toBeNull();
});
