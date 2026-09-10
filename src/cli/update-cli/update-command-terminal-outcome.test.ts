import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as triageUpdate from "../../commands/triage-update.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "../../infra/package-update-swap.test-support.js";
import { readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as sentinel from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { prepareNativePackageStage } from "../../infra/update-native-package-stage.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateStepResult } from "../../infra/update-runner.js";
import * as triage from "../../infra/update-triage.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import {
  finishSuccessfulPackageSwitch,
  taskRecovery,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

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
beforeEach(async () => {
  base = await fs.realpath(dirs.make("update-terminal-outcome-"));
  temporary = path.join(base, "private-tmp");
  await fs.mkdir(temporary, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  jsonOutput = [];
  humanOutput = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    jsonOutput.push(structuredClone(value));
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
    humanOutput.push(String(value));
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
    humanOutput.push(String(value));
  });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createNativeRefusalSwap() {
  const project = path.join(base, "native", "global");
  const globalRoot = path.join(project, "5", "node_modules");
  const packageRoot = path.join(globalRoot, "openclaw");
  const binDir = path.join(base, "native", "bin");
  await writePackageRoot(packageRoot, "1.0.0");
  await fs.mkdir(binDir, { recursive: true });
  const manifest = path.join(project, "package.json");
  await fs.writeFile(manifest, '{"dependencies":{"openclaw":"1.0.0"}}');
  const launcher = path.join(binDir, "openclaw");
  await fs.writeFile(launcher, "old launcher\n");
  const installTarget = { manager: "pnpm" as const, command: "pnpm", globalRoot, packageRoot };
  const native = await prepareNativePackageStage({
    installTarget,
    packageName: "openclaw",
    installSpec: "openclaw@2.0.0",
    globalBinDir: binDir,
    env: {},
  });
  if (!native) {
    throw new Error("native fixture stage unavailable");
  }
  const candidate = path.join(native.projectRoot, path.relative(project, packageRoot));
  await writePackageRoot(candidate, "2.0.0");
  await fs.writeFile(path.join(native.binDir, "openclaw"), "candidate launcher\n");
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    installTarget,
    packageName: "openclaw",
    stage: {
      prefix: native.projectRoot,
      layout: { prefix: native.projectRoot, globalRoot: native.globalRoot, binDir: native.binDir },
      packageRoot: candidate,
      installTarget: { ...installTarget, globalRoot: native.globalRoot, packageRoot: candidate },
      native,
    },
    onTransaction: (value) => {
      transaction = value;
    },
  });
  if (!transaction || result.status !== "committed") {
    throw new Error(`native fixture swap failed: ${result.step.stderrTail}`);
  }
  return { packageRoot, globalRoot, launcher, transaction, manifest, result };
}

async function scenario(
  kind:
    | "healthy"
    | "renamed"
    | "retained"
    | "release-failure"
    | "revoked"
    | "foreign-revoked"
    | "link-retained"
    | "link-retained-once"
    | "link-authority-read"
    | "last-cleanup-read"
    | "link-changed"
    | "transient-read"
    | "cleanup-read"
    | "unverified-completion"
    | "rollback-refused",
  json: boolean,
  repeat = false,
  deferred = true,
) {
  let swap;
  let nativeManifest: string | undefined;
  let prerequisiteResult: unknown;
  let setupInjected = false;
  if (kind === "rollback-refused") {
    const native = await createNativeRefusalSwap();
    nativeManifest = native.manifest;
    swap = native;
  } else if (kind === "unverified-completion") {
    const fixture = await createPackageSwapFixture(base);
    const rename = fs.rename.bind(fs);
    const effect = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.packageRoot) {
        setupInjected = true;
        throw Object.assign(new Error("fixture publication move denied"), { code: "EXDEV" });
      }
      return rename(...args);
    });
    let transaction: PackageUpdateTransaction | undefined;
    let result;
    try {
      result = await swapStagedPackageInstall({
        ...fixture.params,
        onTransaction: (value) => {
          transaction = value;
        },
      });
    } finally {
      effect.mockRestore();
    }
    if (!transaction || result.status !== "failed") {
      throw new Error("unverified fixture did not retain its failed transaction");
    }
    prerequisiteResult = result;
    swap = { ...fixture, transaction, result };
  } else if (
    [
      "link-retained",
      "link-retained-once",
      "link-authority-read",
      "link-changed",
      "transient-read",
    ].includes(kind)
  ) {
    const fixture = await createPackageSwapFixture(base);
    const checkout = path.join(base, "operator-checkout");
    await fs.rename(fixture.packageRoot, checkout);
    await fs.symlink(
      checkout,
      fixture.packageRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    let transaction: PackageUpdateTransaction | undefined;
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      onTransaction: (value) => {
        transaction = value;
      },
    });
    if (!transaction || result.status !== "committed") {
      throw new Error("linked swap failed");
    }
    swap = { ...fixture, result, transaction };
  } else {
    swap = await createRetainedPackageSwap(base);
  }
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
  const rm = fs.rm.bind(fs);
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  const readlink = fs.readlink.bind(fs);
  const shimBackup = (await fs.readdir(swap.globalRoot)).find((entry) =>
    entry.startsWith(".openclaw.shim-backup-"),
  );
  const finalCleanupRoot = shimBackup && path.join(swap.globalRoot, shimBackup);
  const mutateLease = (sql: string) => {
    const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  let injected = setupInjected;
  let failNextLeaseRead = false;
  const lstat = syncFs.lstatSync.bind(syncFs);
  vi.spyOn(syncFs, "lstatSync").mockImplementation((...args) => {
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
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (String(args[0]) === swap.transaction.backupRoot) {
      if (kind === "renamed" || kind === "retained") {
        injected = true;
        throw Object.assign(new Error("fixture obsolete backup deletion denied"), {
          code: "EACCES",
        });
      }
      await rm(...args);
      if (kind === "cleanup-read") {
        failNextLeaseRead = true;
      }
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
      }
      return;
    }
    await rm(...args);
    if (kind === "last-cleanup-read" && String(args[0]) === finalCleanupRoot) {
      failNextLeaseRead = true;
    }
  });
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (kind === "retained" && String(args[0]) === swap.transaction.backupRoot) {
      throw Object.assign(new Error("fixture fallback rename denied"), { code: "EACCES" });
    }
    return rename(...args);
  });
  vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
    if (
      (kind === "link-retained" || (kind === "link-retained-once" && !injected)) &&
      String(args[0]) === swap.transaction.backupRoot
    ) {
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
  vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
    const value = await readlink(...args);
    if (
      kind === "link-authority-read" &&
      !injected &&
      String(args[0]) === swap.transaction.backupRoot
    ) {
      failNextLeaseRead = true;
    }
    return value;
  });
  let repeatedCompletion: UpdateStepResult | void = undefined;
  let repeatedFailure: string | undefined;
  let failure: unknown;
  const execute = () =>
    withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(swap.packageRoot);
      if (nativeManifest) {
        await fs.writeFile(
          nativeManifest,
          '{"dependencies":{"openclaw":"2.0.0","sibling":"3.0.0"}}',
        );
        injected = true;
        prerequisiteResult = await swap.transaction.rollback(() =>
          run.executorFence!.assertCurrent(),
        );
      }
      try {
        await finishSuccessfulPackageSwitch(
          { packageRoot: swap.packageRoot, run, json },
          {
            result: {
              status: "ok",
              mode: "npm",
              root: swap.packageRoot,
              before: { version: "1.0.0" },
              after: { version: "2.0.0" },
              steps: [],
              durationMs: 0,
            },
            packageTransaction: swap.transaction,
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
          } catch (error) {
            repeatedFailure = error instanceof Error ? error.message : String(error);
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
    });
  try {
    if (deferred) {
      await withUpdateCommandTerminalResult(run, execute);
    } else {
      await execute();
    }
  } catch (error) {
    failure = error;
  }
  if (kind === "foreign-revoked" && failure instanceof UpdateCommandPendingRecoveryFailure) {
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
  const retainedName = path
    .basename(swap.transaction.backupRoot)
    .replace(/^\.openclaw\./, ".openclaw-");
  const expectedRetained =
    kind === "renamed" ? path.join(swap.globalRoot, retainedName) : swap.transaction.backupRoot;
  const retainedExists = await fs.stat(expectedRetained).then(
    () => true,
    () => false,
  );
  const history = getUpdateRun(run.runId, { env: run.env });
  const report = history ? renderUpdateRunReport(history).markdown : "missing history";
  const beforeRepeat = structuredClone(history);
  finishUpdateRun(
    run.runId,
    { status: "failed", reason: "late conflicting outcome" },
    { env: run.env },
  );
  const afterRepeat = getUpdateRun(run.runId, { env: run.env });
  const observations = {
    kind,
    json,
    deferred,
    injected,
    repeatedCompletion,
    repeatedFailure,
    prerequisiteResult,
    exitCode: failure instanceof UpdateCommandFailure ? failure.exitCode : failure ? 1 : 0,
    failure: failure instanceof Error ? failure.message : failure,
    expectedRetained,
    retainedExists,
    package: JSON.parse(await fs.readFile(path.join(swap.packageRoot, "package.json"), "utf8")),
    launcher: await fs.readFile(swap.launcher, "utf8"),
    jsonOutput,
    humanOutput,
    history,
    report,
    beforeRepeat,
    afterRepeat,
    lease: createManagedHandoffLeaseStore().read(swap.packageRoot).kind,
  };
  const evidence = process.env.OPENCLAW_TERMINAL_PROOF_DIR;
  if (evidence) {
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(
      path.join(
        evidence,
        `${kind}-${json ? "json" : "human"}${repeat ? "-repeat" : ""}${deferred ? "" : "-direct"}.json`,
      ),
      JSON.stringify(observations, null, 2),
    );
  }
  return { ...observations, swap, run };
}

describe("composed cleanup and terminal outcome", () => {
  it.each([true, false])(
    "reports actual retained backup after verified activation (json=%s)",
    async (json) => {
      const value = await scenario("renamed", json);
      expect(value.injected).toBe(true);
      expect(value.package.version).toBe("2.0.0");
      expect(value.launcher).toBe("candidate launcher\n");
      expect(value.exitCode).toBe(0);
      expect(value.retainedExists).toBe(true);
      expect(value.history?.status).toBe("succeeded");
      const output = json ? JSON.stringify(value.jsonOutput) : value.humanOutput.join("\n");
      expect(output).toContain(value.expectedRetained);
      expect(JSON.stringify(value.history)).toContain(value.expectedRetained);
      expect(value.report).toContain(value.expectedRetained);
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
    },
  );
  it.each([true, false])(
    "reports original backup when fallback rename is denied (json=%s)",
    async (json) => {
      const value = await scenario("retained", json);
      expect(value.injected).toBe(true);
      expect(value.retainedExists).toBe(true);
      expect(value.exitCode).toBe(0);
      const output = json ? JSON.stringify(value.jsonOutput) : value.humanOutput.join("\n");
      expect(output).toContain(value.expectedRetained);
      expect(JSON.stringify(value.history)).toContain(value.expectedRetained);
      expect(value.report).toContain(value.expectedRetained);
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
    },
  );
  it.each(["renamed", "retained"] as const)(
    "keeps repeated completion truthful for %s backup",
    async (kind) => {
      const value = await scenario(kind, true, true);
      expect(value.retainedExists).toBe(true);
      expect(value.repeatedCompletion).toMatchObject({
        exitCode: 1,
        stderrTail: expect.stringContaining(value.expectedRetained),
      });
    },
  );
  it("caches the first link-retirement outcome after a one-shot deletion failure", async () => {
    const value = await scenario("link-retained-once", true, true);
    expect(value.injected).toBe(true);
    expect(value.repeatedCompletion).toMatchObject({ exitCode: 1 });
    expect(value.retainedExists).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it.each(["link-authority-read", "last-cleanup-read"] as const)(
    "caches the first retirement authority failure for %s",
    async (kind) => {
      const value = await scenario(kind, true, true);
      expect(value.injected).toBe(true);
      expect(value.repeatedFailure).toBeDefined();
      expect(value.exitCode).toBe(1);
      expect(value.jsonOutput).toHaveLength(1);
      expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
      expect(value.history?.status).toBe("failed");
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
      expect(value.retainedExists).toBe(kind === "link-authority-read");
    },
  );
  it("keeps unqualified link retirement failure hard without deleting its checkout", async () => {
    const value = await scenario("link-retained", true);
    expect(value.injected).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.history?.status).toBe("failed");
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.retainedExists).toBe(true);
    expect(JSON.stringify(value.jsonOutput)).toContain(value.expectedRetained);
    // Hard failures use the canonical bounded summary; JSON above retains the full path.
    expect(JSON.stringify(value.history)).toContain(path.basename(value.expectedRetained));
    expect(value.report).toContain(path.basename(value.expectedRetained));
    expect(
      JSON.parse(await fs.readFile(path.join(base, "operator-checkout", "package.json"), "utf8"))
        .version,
    ).toBe("1.0.0");
  });
  it.each([
    "unverified-completion",
    "rollback-refused",
    "link-changed",
    "transient-read",
    "cleanup-read",
  ] as const)("keeps producer-qualification failure hard for %s", async (kind) => {
    const value = await scenario(kind, true);
    expect(value.injected).toBe(true);
    if (kind === "rollback-refused") {
      expect(value.prerequisiteResult).toMatchObject({
        exitCode: 1,
        reason: "rollback-project-changed",
      });
      expect(value.retainedExists).toBe(true);
      expect(value.package.version).toBe("2.0.0");
    }
    if (kind === "unverified-completion") {
      expect(value.prerequisiteResult).toMatchObject({ status: "failed" });
      expect(value.package.version).toBe("1.0.0");
    }
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({
      status: "error",
      steps: expect.not.arrayContaining([expect.objectContaining({ advisory: expect.anything() })]),
    });
    expect(value.history?.status).toBe("failed");
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it("publishes the hard completion result through the direct finalizer fallback", async () => {
    const value = await scenario("unverified-completion", true, false, false);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.history?.status).toBe("failed");
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it.each(["release-failure", "revoked"] as const)(
    "publishes one failed outcome after %s",
    async (kind) => {
      const value = await scenario(kind, true);
      expect(value.injected).toBe(true);
      expect(value.exitCode).toBe(1);
      expect(value.package.version).toBe("2.0.0");
      expect(value.jsonOutput).toHaveLength(1);
      expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
      expect(value.history?.status).toBe("failed");
      expect(value.report.toLowerCase()).toContain("failed");
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
    },
  );
  it("preserves foreign terminal history and emits only the pending failure", async () => {
    const value = await scenario("foreign-revoked", true);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.history).toMatchObject({ status: "failed", reason: "foreign-terminal-fact" });
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it.each([true, false])(
    "keeps healthy cleanup and terminal output consistent (json=%s)",
    async (json) => {
      const value = await scenario("healthy", json);
      expect(value.exitCode).toBe(0);
      expect(value.retainedExists).toBe(false);
      expect(value.history?.status).toBe("succeeded");
      expect(value.lease).toBe("absent");
      if (json) {
        expect(value.jsonOutput).toHaveLength(1);
        expect(value.jsonOutput[0]).toMatchObject({ status: "ok" });
      } else {
        expect(value.humanOutput.join("\n").toLowerCase()).toContain("updated");
      }
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
    },
  );
});

function retainedTree(root: string) {
  return syncFs
    .readdirSync(root, { recursive: true })
    .map(String)
    .toSorted()
    .map((name) => {
      const file = path.join(root, name);
      const stat = syncFs.lstatSync(file);
      return {
        name,
        ino: stat.ino,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        content: stat.isFile()
          ? syncFs.readFileSync(file)
          : stat.isSymbolicLink()
            ? syncFs.readlinkSync(file)
            : null,
      };
    });
}

async function journalFixture(root: string) {
  const fixture = await createPackageSwapFixture(root);
  const worker = path.join(
    fixture.params.stage.packageRoot,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  // Use the actual candidate capability probe; the invocation compiler owns its closure.
  await fs.writeFile(
    worker,
    `import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize).href)});\n`,
  );
  await writePackageDistInventory(fixture.params.stage.packageRoot);
  return fixture;
}

describe.skipIf(process.platform === "win32")("journaled terminal publication", () => {
  it.each([
    "revoked",
    "admission-race",
    "direct-sentinel-revoked",
    "deferred-sentinel-journal",
    "healthy",
    "live-direct",
  ] as const)("keeps package admission and terminal ownership ordered (%s)", async (kind) => {
    const fixture = await journalFixture(base);
    const next =
      kind === "admission-race" || kind === "deferred-sentinel-journal"
        ? await journalFixture(path.join(base, "next"))
        : null;
    const direct = kind === "live-direct" || kind === "direct-sentinel-revoked";
    const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
      env: { ...process.env },
    };
    const opts = { json: true, yes: true, run };
    const windows = taskRecovery();
    const runTriage = vi.fn(async () => ({ status: "cancelled" as const }));
    vi.spyOn(triage, "prepareUpdateFailureTriage").mockResolvedValue(runTriage);
    const writeSentinel = sentinel.writeControlPlaneUpdateRestartSentinel;
    const sentinelWriter = vi.spyOn(sentinel, "writeControlPlaneUpdateRestartSentinel");
    const writers = [
      vi.spyOn(ledger, "finishUpdateRun"),
      vi.spyOn(ledger, "recordUpdateRunPhase"),
      vi.spyOn(ledger, "recordUpdateRunStep"),
      sentinelWriter,
      vi.spyOn(triageUpdate, "writeTriageUpdateFailure"),
    ];
    const stateRoot = path.dirname(resolveOpenClawStateSqlitePath(run.env));
    let transaction: PackageUpdateTransaction | undefined;
    let rollbackCalls = () => 0;
    let admissionArmed = false;
    let injected = false;
    let before:
      | { state: ReturnType<typeof retainedTree>; journal: ReturnType<typeof retainedTree> }
      | undefined;
    let writesBefore: number[] | undefined;
    let historyReadsBefore: number | undefined;
    const historyReads = vi.spyOn(ledger, "getUpdateRun");
    const snapshot = () => {
      before = { state: retainedTree(stateRoot), journal: retainedTree(anchor) };
      writesBefore = writers.map((writer) => writer.mock.calls.length);
      historyReadsBefore = historyReads.mock.calls.length;
    };
    const revokeOriginal = () => {
      const authority = captureUpdateCommandExecutorAuthority(run.executorFence!);
      const database = new DatabaseSync(authority.databasePath);
      try {
        database
          .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
          .run("replacement-owner", authority.installKey);
      } finally {
        database.close();
      }
    };
    const publishNext = async () => {
      if (!next) {
        throw new Error("Second package fixture is missing");
      }
      await withUpdateCommandExecutor("next-update", async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        const published = await swapStagedPackageInstall({
          ...next.params,
          installTarget: fixture.params.installTarget,
          activation: { fence, nodeRunner: process.execPath, onPrepared: () => undefined },
          onTransaction: () => undefined,
        });
        expect(published.status, published.step.stderrTail ?? undefined).toBe("committed");
      });
    };
    sentinelWriter.mockImplementation(async (...args) => {
      await writeSentinel(...args);
      if (
        injected ||
        args[0].result.status !== "ok" ||
        (kind !== "direct-sentinel-revoked" && kind !== "deferred-sentinel-journal")
      ) {
        return;
      }
      injected = true;
      expect(await readRestartSentinelReadOnly(run.env)).toMatchObject({
        payload: { status: "ok", stats: { runId: run.runId } },
      });
      if (kind === "direct-sentinel-revoked") {
        revokeOriginal();
      } else {
        await publishNext();
      }
      // The dispatched sentinel is committed. Only subsequent publication is forbidden.
      snapshot();
    });
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      await rm(...args);
      if (kind !== "revoked" || injected || String(args[0]) !== transaction?.backupRoot) {
        return;
      }
      injected = true;
      revokeOriginal();
      snapshot();
    });
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const entries = await readdir(...args);
      if (
        kind === "admission-race" &&
        admissionArmed &&
        !injected &&
        String(args[0]) === stateRoot
      ) {
        injected = true;
        await publishNext();
        snapshot();
      }
      return entries;
    });
    const execute = () =>
      withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        run.executorFence = fence;
        const published = await swapStagedPackageInstall({
          ...fixture.params,
          activation: { fence, nodeRunner: process.execPath, onPrepared: () => undefined },
          onTransaction: (value) => {
            transaction = value;
          },
        });
        expect(published.status, published.step.stderrTail ?? undefined).toBe("committed");
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
        if (!transaction) {
          throw new Error("Journaled transaction was not retained");
        }
        const rollback = vi.spyOn(transaction, "rollback");
        rollbackCalls = () => rollback.mock.calls.length;
        await withUpdateCommandRecoveryUnwind(
          opts,
          {
            triageTarget: { root: fixture.packageRoot, env: run.env },
            windowsTaskAutoStartRecovery: windows,
          },
          async () => {
            await finishSuccessfulPackageSwitch(
              { packageRoot: fixture.packageRoot, run, json: true },
              {
                packageTransaction: direct ? undefined : transaction,
                shouldRestart: false,
                installKindChanged: false,
                downgradeRisk: false,
                controlPlaneUpdateSentinelMeta: { runId: run.runId, note: "requested update" },
              },
            );
            if (kind === "live-direct") {
              expect(openPackageActivationJournal(anchor).read().phase).toBe(
                "publication-complete",
              );
              expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("succeeded");
              await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
            }
          },
        );
      });
    let failure: unknown;
    await withUpdateFailureTriage(opts, { root: fixture.packageRoot, env: run.env }, () =>
      direct
        ? execute()
        : withUpdateCommandTerminalResult(run, async () => {
            await execute();
            admissionArmed = true;
          }),
    ).catch((error: unknown) => {
      failure = error;
    });
    expect(rollbackCalls()).toBe(0);
    expect(runTriage).not.toHaveBeenCalled();
    expect(jsonOutput).toHaveLength(1);
    if (kind !== "healthy" && kind !== "live-direct") {
      expect(injected).toBe(true);
      expect(before).toBeDefined();
      expect(failure).toMatchObject({ code: 1 });
      expect(jsonOutput[0]).toMatchObject({
        status: "error",
        recovery: { serviceRestartSafe: false },
      });
      expect(writers.map((writer) => writer.mock.calls.length)).toEqual(writesBefore);
      expect(historyReads.mock.calls.length).toBe(historyReadsBefore);
      expect({ state: retainedTree(stateRoot), journal: retainedTree(anchor) }).toEqual(before);
      if (kind === "revoked" || kind === "direct-sentinel-revoked") {
        expect(windows.restore).not.toHaveBeenCalled();
        expect(windows.complete).not.toHaveBeenCalled();
      }
    } else {
      expect(failure).toBeUndefined();
      expect(syncFs.existsSync(anchor)).toBe(false);
      expect(jsonOutput[0]).toMatchObject({ status: "ok" });
      expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("succeeded");
      expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
    }
  });
});
