import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureUpdateCommandExecutorAuthority,
  captureUpdateCommandExecutorCurrentStores,
  captureUpdateCommandRecoveryGenerationAuthority,
  publishUpdateCommandPackageGeneration,
  publishUpdateCommandRecoveryGeneration,
  requestUpdateCommandExecutorCancellation,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "../cli/update-cli/update-command-executor.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import {
  encodePackageActivationLauncher,
  openPackageActivationJournal,
} from "./package-update-activation-journal.js";
import {
  createPackageActivationForwardProvider,
  preparePackageActivation,
  readPackageActivationReceipt,
} from "./package-update-activation.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { createUnchangedReversePreparation } from "./package-update-reverse-recovery.test-support.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as runtimeWorker from "./runtime-worker-url.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";
import {
  currentUpdateInitialStoreAdmission,
  withUpdateInitialStoreInvocation,
} from "./update-initial-store-invocation.js";
import { createManagedHandoffLeaseDatabase } from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { enterUpdateRecoveryStartup } from "./update-recovery-startup-entry.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

const roots: string[] = [];
const dirs = {
  make(prefix: string) {
    const base = process.env.OPENCLAW_NATIVE_PROVIDER_TEST_ROOT ?? fs.realpathSync(os.tmpdir());
    if (fs.realpathSync(base) !== base) {
      throw new Error("Aliased private fixture root");
    }
    const root = fs.mkdtempSync(path.join(base, prefix));
    roots.push(root);
    return root;
  },
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const identity = (file: string) => {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

async function fixture(options: { realHelper?: boolean } = {}) {
  const root = fs.realpathSync(dirs.make("forward-generation-"));
  fs.chmodSync(root, 0o700);
  const packageFixture = await createPackageSwapFixture(root);
  const stateDir = path.join(root, "state");
  const coordinator = path.join(root, "coordinator");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(coordinator, { mode: 0o700 });
  const state = path.join(stateDir, "openclaw.sqlite");
  const db = new DatabaseSync(state);
  try {
    db.exec(
      "CREATE TABLE acknowledged(value TEXT); INSERT INTO acknowledged VALUES ('newer write')",
    );
  } finally {
    db.close();
  }
  fs.chmodSync(state, 0o600);
  const handoff = path.join(root, "handoff.sqlite");
  createManagedHandoffLeaseDatabase(handoff)(true, () => {});
  const select = (file: string) => ({
    databasePath: file,
    databaseIdentity: identity(file),
    parentIdentity: identity(path.dirname(file)),
  });
  const selection = {
    privateRoot: { path: root, identity: identity(root) },
    installation: {
      path: packageFixture.packageRoot,
      identity: identity(packageFixture.packageRoot),
    },
    handoff: select(handoff),
    state: select(state),
  };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  // Only the helper's executable bytes/capability probe are inert fixtures. All
  // owner, journal, inode, native lease, child and publication checks are real.
  if (!options.realHelper) {
    const helper = path.join(root, "sealed.mjs");
    fs.writeFileSync(helper, "// inert sealed helper fixture\n");
    const originalResolve = runtimeWorker.resolveRuntimeWorkerUrl;
    vi.spyOn(runtimeWorker, "resolveRuntimeWorkerUrl").mockImplementation((entry) =>
      entry.sourceWorkerName === "package-update-activation-sealed"
        ? pathToFileURL(helper)
        : originalResolve(entry),
    );
  }
  const probe = path.join(
    packageFixture.params.stage.packageRoot,
    "dist/infra/update-migrated-finalize.worker.js",
  );
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  // Capability probes intentionally get env:{}, so they establish their own
  // pre-open guard at entry. No database is needed or allowed in these probes.
  fs.writeFileSync(
    probe,
    `const sqlite = require('node:sqlite');
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {construct() {throw new Error('Capability probe cannot open SQLite');}});
require('node:module').syncBuiltinESMExports();
require('node:fs').appendFileSync(${JSON.stringify(process.env.OPENCLAW_CALLER_SQLITE_LOG ?? path.join(root, "probe-audit.jsonl"))}, JSON.stringify({pid:process.pid,threadId:0,event:'guard-ready',policy:'deny-all-sqlite-before-probe'})+'\\n');
console.log(${JSON.stringify(JSON.stringify({ postCoreExecutor: "fd3-pid-start-v1", mutationProtocol: "original-cancellation-v1" }))});\n`,
  );
  fs.writeFileSync(
    path.join(packageFixture.packageRoot, "dist/build-info.json"),
    JSON.stringify({ buildId: "forward-fixture", commit: "a".repeat(40) }),
  );
  fs.writeFileSync(
    path.join(packageFixture.packageRoot, "dist/index.js"),
    `const agent = process.argv.includes("preflight-agent");
console.log(JSON.stringify({
  schema: agent ? "openclaw.agent-schema-preflight.v1" : "openclaw.state-schema-preflight.v1",
  status: "exact", foundVersion: 19, targetVersion: 19, requiresWrite: false, issues: []
}));\n`,
  );
  const childGuard = path.join(root, "private-sqlite.cjs");
  fs.writeFileSync(
    childGuard,
    `const sqlite = require("node:sqlite"); sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {construct() {throw new Error("Idle child must not open SQLite");}}); require("node:module").syncBuiltinESMExports();`,
  );
  const runId = randomUUID();
  const store = createManagedHandoffLeaseStore({
    databasePath: handoff,
    existingIdentity: selection.handoff,
    serviceManagerEnv: {},
  });
  const execute = async (
    run: (fence: UpdateRecoveryFence) => Promise<void>,
    after?: () => void,
  ) => {
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    try {
      await withStateDatabaseCoordinatorRuntimeDirectory(coordinator, () =>
        maintenance.run(() =>
          withUpdateInitialStoreInvocation({ version: 1, selection }, async () => {
            await withUpdateCommandExecutor(
              runId,
              async (executor) => run(await executor.enter(packageFixture.packageRoot)),
              {
                directOriginal: { databasePath: handoff },
                initialStores: { protocol: "initial-pair-v1", selection },
              },
            );
            after?.();
          }),
        ),
      );
    } finally {
      await maintenance.close();
    }
  };
  const prepare = async (fence: UpdateRecoveryFence) => {
    const reader = createPackageIntegrityReader();
    const prepared = await preparePackageActivation({
      installTarget: packageFixture.params.installTarget,
      options: {
        fence,
        runId,
        nodeRunner: process.execPath,
        onPrepared: () => {},
        onUnavailable: (message) => {
          throw new Error(message);
        },
      },
      liveRoot: packageFixture.packageRoot,
      stageRoot: packageFixture.params.stage.packageRoot,
      launcherRoot: packageFixture.params.stage.layout.binDir,
      binDir: path.dirname(packageFixture.launcher),
      previous: await reader.tree(packageFixture.packageRoot),
      launchers: [
        {
          name: "openclaw",
          previous: encodePackageActivationLauncher(await reader.launcher(packageFixture.launcher)),
        },
      ],
    });
    if (!prepared) {
      throw new Error("Real provider was not prepared");
    }
    return prepared;
  };
  return {
    ...packageFixture,
    root,
    state,
    handoff,
    coordinator,
    runId,
    selection,
    childGuard,
    store,
    execute,
    prepare,
  };
}

it.skipIf(process.platform === "win32")(
  "retains native descendant exclusion in the captured continuing authority and succeeds after actual child settlement",
  async () => {
    const f = await fixture();
    let retained!: () => void;
    await f.execute(async (fence) => {
      retained = captureUpdateCommandRecoveryGenerationAuthority(fence, f.runId);
      await withUpdateCommandExecutorChild(fence, f.packageRoot, async (_grant, bindChild) => {
        const child = spawn(
          process.execPath,
          ["--require", f.childGuard, "-e", "process.stdin.resume()"],
          {
            stdio: ["pipe", "ignore", "pipe"],
          },
        );
        const closed = once(child, "close");
        try {
          await once(child, "spawn");
          if (!child.pid) {
            throw new Error("Missing child PID");
          }
          bindChild(child.pid, child.spawnargs);
          expect(retained).toThrow(/still running/);
          expect(() =>
            publishUpdateCommandPackageGeneration(fence, f.runId, "not-admitted"),
          ).toThrow(/still running/);
          expect(identity(f.packageRoot)).toBe(f.selection.installation.identity);
          child.stdin.end();
          expect((await closed)[0]).toBe(0);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          await closed;
        }
      });
      retained();
      const prepared = await f.prepare(fence);
      expect((await prepared.publish(false)).phase).toBe("publication-complete");
      retained();
    });
    expect(retained).toThrow(/outlived/);
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
  },
);

it.skipIf(process.platform === "win32")(
  "publishes the real prepared provider across displacement under the same native owner and selects only the recorded after-image",
  async () => {
    const f = await fixture();
    let old!: NonNullable<ReturnType<typeof currentUpdateInitialStoreAdmission>>;
    let observedGap = false;
    await f.execute(
      async (fence) => {
        const original = captureUpdateCommandExecutorAuthority(fence, f.runId);
        const continuing = captureUpdateCommandRecoveryGenerationAuthority(fence, f.runId);
        const prepared = await f.prepare(fence);
        const descriptor = prepared.journal.read().descriptor;
        expect(() =>
          createPackageActivationForwardProvider(
            prepared.anchor,
            prepared.journal,
            () => {},
            prepared.journal.read(),
          ),
        ).toThrow(/prepared inline owner/);
        old = currentUpdateInitialStoreAdmission()!;
        const rename = fsp.rename;
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          await rename(from, to);
          if (String(from) === f.packageRoot) {
            observedGap = true;
            expect(fs.existsSync(f.packageRoot)).toBe(false);
            expect(old.assertCurrent).toThrow(/settled/);
            expect(fence.assertCurrent).toThrow(/unresolved/);
            expect(currentUpdateInitialStoreAdmission).toThrow(/publication has not settled/);
            continuing();
            const live = f.store.read(f.packageRoot);
            expect(live.kind === "current" && live.lease.owner).toBe(original.owner);
          }
        });
        let displacedCalls = 0;
        await prepared.publish(false, async () => {
          displacedCalls++;
          expect(fs.existsSync(f.packageRoot)).toBe(false);
          prepared.assertCurrent();
          expect(prepared.status().phase).toBe("publishing");
          await Promise.resolve();
          prepared.assertCurrent();
        });
        expect(displacedCalls).toBe(1);
        prepared.assertCurrent();
        expect(prepared.status().phase).toBe("publication-complete");
        fence.assertCurrent();
        expect(captureUpdateCommandExecutorAuthority(fence, f.runId)).toEqual(original);
        const selected = captureUpdateCommandExecutorCurrentStores(fence, f.runId)!.selection;
        expect(selected).toEqual({
          ...f.selection,
          installation: { path: f.packageRoot, identity: descriptor.candidate.identity },
        });
        expect(identity(f.packageRoot)).toBe(descriptor.candidate.identity);
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        const db = new DatabaseSync(f.state, { readOnly: true });
        try {
          currentUpdateInitialStoreAdmission()!.observeConnection("state", db);
          expect(db.prepare("SELECT value FROM acknowledged").get()?.value).toBe("newer write");
        } finally {
          db.close();
        }
      },
      () => currentUpdateInitialStoreAdmission()!.assertCurrent(),
    );
    expect(observedGap).toBe(true);
    expect(old.assertCurrent).toThrow(/settled/);
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
  },
);

it.skipIf(process.platform === "win32")(
  "allows only the selected retained runtime's shipped database preflight",
  async () => {
    const f = await fixture({ realHelper: true });
    let anchor = "";
    await f.execute(async (fence) => {
      fs.copyFileSync(f.launcher, path.join(f.params.stage.layout.binDir, "openclaw"));
      const prepared = await f.prepare(fence);
      await prepared.publish(false);
      anchor = prepared.anchor;
    });
    const retainedRoot = path.join(anchor, "previous");
    const entryFile = path.join(retainedRoot, "dist/index.js");
    const copiedDatabase = path.join(f.root, "prepared.sqlite");
    await expect(
      enterUpdateRecoveryStartup({
        installRoot: retainedRoot,
        entryFile,
        argv: [process.execPath, entryFile, "database", "preflight", copiedDatabase, "--json"],
      }),
    ).resolves.toBe(false);
    await expect(
      enterUpdateRecoveryStartup({
        installRoot: retainedRoot,
        entryFile,
        argv: [process.execPath, entryFile, "gateway"],
      }),
    ).rejects.toThrow("recovery-inspection only");
  },
  180_000,
);

it.skipIf(process.platform === "win32")(
  "repairs reverse-complete through the sealed helper before terminal retirement",
  async () => {
    const f = await fixture({ realHelper: true });
    let anchor = "";
    let interrupted: unknown;
    try {
      await f.execute(async (fence) => {
        fs.copyFileSync(f.launcher, path.join(f.params.stage.layout.binDir, "openclaw"));
        const prepared = await f.prepare(fence);
        await prepared.publish(false);
        anchor = prepared.anchor;
        const record = prepared.journal.read();
        const current = captureUpdateCommandExecutorCurrentStores(fence, f.runId);
        const maintenance = getOpenClawDatabaseMaintenanceScope();
        if (!current || !maintenance) {
          throw new Error("Missing selected current stores or maintenance scope");
        }
        const custody = await prepared.resourceCustody({
          assertCurrent: prepared.assertCurrent,
          assertWritersSettled: prepared.assertCurrent,
        });
        const preparation = await createUnchangedReversePreparation({
          root: f.root,
          runId: f.runId,
          state: f.state,
          packageRoot: f.packageRoot,
          operationId: record.descriptor.operationId,
          descriptor: record.descriptor,
          selection: current.selection,
          packageResources: [...custody.packageResources],
          stagingParent: custody.stagingParent(f.state),
        });
        vi.spyOn(prepared, "commitCompletion").mockRejectedValueOnce(
          new Error("simulated death before terminal acknowledgement"),
        );
        await publishUpdateCommandRecoveryGeneration(fence, f.runId, {
          binding: preparation,
          transaction: {
            backupRoot: prepared.anchor,
            reversePublication: {
              selection: () => ({
                anchor: prepared.anchor,
                operationId: record.descriptor.operationId,
                originalRunId: record.descriptor.originalRunId,
                previous: record.descriptor.previous,
                previousRuntime: record.descriptor.previousRuntime,
              }),
              resourceCustody: prepared.resourceCustody,
              prepare: prepared.prepareReverse,
              publish: prepared.reverse,
              settle: prepared.settleReverse,
              verifyCompletion: prepared.verifyCompletion,
              commitCompletion: prepared.commitCompletion,
            },
            rollback: vi.fn(),
            complete: vi.fn(),
          },
          maintenance,
          assertWritersSettled: () => maintenance.assertAdmission(),
          assertCapturedSource: vi.fn(),
          validateTarget: vi.fn(async () => maintenance.assertAdmission()),
        });
      });
    } catch (error) {
      interrupted = error;
    }
    if (openPackageActivationJournal(anchor).read().phase !== "reverse-complete") {
      throw interrupted;
    }
    fs.rmSync(path.join(path.dirname(f.state), "openclaw.json.lock"), { force: true });
    expect(interrupted).toBeInstanceOf(Error);
    expect(openPackageActivationJournal(anchor).read().phase).toBe("reverse-complete");
    const restoredEntry = path.join(f.packageRoot, "dist/index.js");
    await expect(
      enterUpdateRecoveryStartup({
        installRoot: f.packageRoot,
        entryFile: restoredEntry,
        argv: [
          process.execPath,
          restoredEntry,
          "database",
          "preflight",
          path.join(f.root, "prepared.sqlite"),
          "--json",
        ],
      }),
    ).resolves.toBe(false);
    await expect(
      enterUpdateRecoveryStartup({
        installRoot: f.packageRoot,
        entryFile: restoredEntry,
        argv: [process.execPath, restoredEntry, "gateway"],
      }),
    ).rejects.toThrow("use its retained recovery helper");
    const receipt = readPackageActivationReceipt(f.packageRoot);
    const statusCommand = receipt?.recoveryCommand;
    if (!statusCommand) {
      throw new Error("Reverse-complete receipt did not expose its sealed helper");
    }
    const prematureRetire = spawnSync(
      "/bin/sh",
      ["-c", statusCommand.replace(/ status$/u, " retire")],
      {
        env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    expect(prematureRetire.status).toBe(1);
    expect(openPackageActivationJournal(anchor).read().phase).toBe("reverse-complete");
    const repair = spawnSync("/bin/sh", ["-c", statusCommand.replace(/ status$/u, " repair")], {
      env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    expect(repair.error, repair.stderr).toBeUndefined();
    expect(repair.status, repair.stderr).toBe(0);
    expect(JSON.parse(repair.stdout)).toMatchObject({ phase: "rolled-back" });
    expect(openPackageActivationJournal(anchor).read().phase).toBe("rolled-back");
    const readmit = spawnSync("/bin/sh", ["-c", statusCommand.replace(/ status$/u, " repair")], {
      env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    expect(readmit.error, readmit.stderr).toBeUndefined();
    expect(readmit.status, readmit.stderr).toBe(0);
    expect(JSON.parse(readmit.stdout)).toMatchObject({ phase: "rolled-back" });
    await expect(
      enterUpdateRecoveryStartup({
        installRoot: f.packageRoot,
        entryFile: path.join(f.packageRoot, "dist/index.js"),
        argv: [process.execPath, path.join(f.packageRoot, "dist/index.js"), "gateway"],
      }),
    ).resolves.toBe(false);
    const retire = spawnSync("/bin/sh", ["-c", statusCommand.replace(/ status$/u, " retire")], {
      env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    expect(retire.error, retire.stderr).toBeUndefined();
    expect(retire.status, retire.stderr).toBe(0);
  },
  180_000,
);

it.skipIf(process.platform === "win32")(
  "resumes durable reverse preparation after a staged-state copy is torn",
  async () => {
    const f = await fixture({ realHelper: true });
    let anchor = "";
    const interruptedCopy = new Error("simulated death during staged-state copy");
    let interruption: unknown;
    try {
      await f.execute(async (fence) => {
        fs.copyFileSync(f.launcher, path.join(f.params.stage.layout.binDir, "openclaw"));
        const prepared = await f.prepare(fence);
        await prepared.publish(false);
        anchor = prepared.anchor;
        const record = prepared.journal.read();
        const current = captureUpdateCommandExecutorCurrentStores(fence, f.runId);
        const maintenance = getOpenClawDatabaseMaintenanceScope();
        if (!current || !maintenance) {
          throw new Error("Missing selected current stores or maintenance scope");
        }
        const custody = await prepared.resourceCustody({
          assertCurrent: prepared.assertCurrent,
          assertWritersSettled: prepared.assertCurrent,
        });
        const preparation = await createUnchangedReversePreparation({
          root: f.root,
          runId: f.runId,
          state: f.state,
          packageRoot: f.packageRoot,
          operationId: record.descriptor.operationId,
          descriptor: record.descriptor,
          selection: current.selection,
          packageResources: [...custody.packageResources],
          stagingParent: custody.stagingParent(f.state),
          preparedValue: "prepared recovery value",
        });
        vi.spyOn(fsp, "copyFile").mockImplementationOnce(async (_source, destination) => {
          await fsp.writeFile(destination, "partial staged copy", { flag: "wx", mode: 0o600 });
          throw interruptedCopy;
        });
        await publishUpdateCommandRecoveryGeneration(fence, f.runId, {
          binding: preparation,
          transaction: {
            backupRoot: prepared.anchor,
            reversePublication: {
              selection: () => ({
                anchor: prepared.anchor,
                operationId: record.descriptor.operationId,
                originalRunId: record.descriptor.originalRunId,
                previous: record.descriptor.previous,
                previousRuntime: record.descriptor.previousRuntime,
              }),
              resourceCustody: prepared.resourceCustody,
              prepare: prepared.prepareReverse,
              publish: prepared.reverse,
              settle: prepared.settleReverse,
              verifyCompletion: prepared.verifyCompletion,
              commitCompletion: prepared.commitCompletion,
            },
            rollback: vi.fn(),
            complete: vi.fn(),
          },
          maintenance,
          assertWritersSettled: () => maintenance.assertAdmission(),
          assertCapturedSource: vi.fn(),
          validateTarget: vi.fn(async () => maintenance.assertAdmission()),
        });
      });
    } catch (error) {
      interruption = error;
    }
    if (openPackageActivationJournal(anchor).read().phase !== "reverse-preparing") {
      throw interruption;
    }
    fs.rmSync(path.join(path.dirname(f.state), "openclaw.json.lock"), { force: true });
    expect(interruption).toBeInstanceOf(Error);
    expect(openPackageActivationJournal(anchor).read()).toMatchObject({
      phase: "reverse-preparing",
      intent: { kind: "reverse-prepare", effect: "copy" },
    });
    const statusCommand = readPackageActivationReceipt(f.packageRoot)?.recoveryCommand;
    if (!statusCommand) {
      throw new Error("Reverse preparation did not expose its sealed helper");
    }
    const repair = spawnSync("/bin/sh", ["-c", statusCommand.replace(/ status$/u, " repair")], {
      env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    expect(repair.error, repair.stderr).toBeUndefined();
    expect(repair.status, repair.stderr).toBe(0);
    expect(JSON.parse(repair.stdout)).toMatchObject({ phase: "rolled-back" });
    const database = new DatabaseSync(f.state, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM acknowledged ORDER BY rowid").all()).toEqual([
        { value: "newer write" },
        { value: "prepared recovery value" },
      ]);
    } finally {
      database.close();
    }
  },
  180_000,
);

it
  .skipIf(process.platform === "win32")
  .each(["operation", "cancelled", "displaced-package", "replaced-handoff"] as const)(
  "rejects %s before publication and never refreshes the selected owner",
  async (mode) => {
    const f = await fixture();
    let prepared!: Awaited<ReturnType<typeof f.prepare>>;
    const operation = f.execute(async (fence) => {
      prepared = await f.prepare(fence);
      const descriptor = prepared.journal.read().descriptor;
      const retained = captureUpdateCommandRecoveryGenerationAuthority(fence, f.runId);
      expect(() =>
        publishUpdateCommandPackageGeneration({ ...fence }, f.runId, descriptor.operationId),
      ).toThrow(/direct original/);
      expect(() =>
        publishUpdateCommandPackageGeneration(fence, randomUUID(), descriptor.operationId),
      ).toThrow(/original run/);
      if (mode === "cancelled") {
        requestUpdateCommandExecutorCancellation(fence, f.runId, new Error("test cancellation"));
      }
      if (mode === "displaced-package") {
        fs.renameSync(f.packageRoot, `${f.packageRoot}.foreign`);
      }
      if (mode === "replaced-handoff") {
        fs.renameSync(f.handoff, `${f.handoff}.foreign`);
        createManagedHandoffLeaseDatabase(f.handoff)(true, () => {});
      }
      if (mode !== "operation") {
        expect(retained).toThrow();
      }
      if (mode === "operation") {
        await publishUpdateCommandPackageGeneration(fence, f.runId, randomUUID());
      } else {
        await prepared.publish(false);
      }
    });
    await expect(operation).rejects.toThrow();
    const record = openPackageActivationJournal(prepared.anchor).read();
    expect(record.phase).toBe("prepared");
    expect(fs.existsSync(path.join(prepared.anchor, "previous"))).toBe(false);
    expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a failed displacement excluded and preserves the native owner for cleanup",
  async () => {
    const f = await fixture();
    const failed = new Error("publication interrupted after displacement");
    let prepared!: Awaited<ReturnType<typeof f.prepare>>;
    await expect(
      f.execute(async (fence) => {
        prepared = await f.prepare(fence);
        const retained = captureUpdateCommandRecoveryGenerationAuthority(fence, f.runId);
        const rename = fsp.rename;
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          await rename(from, to);
          if (String(from) === f.packageRoot) {
            throw failed;
          }
        });
        await expect(prepared.publish(false)).rejects.toBe(failed);
        expect(fence.assertCurrent).toThrow(/unresolved/);
        expect(retained).toThrow(/unresolved/);
        expect(currentUpdateInitialStoreAdmission).toThrow(/publication has not settled/);
      }),
    ).rejects.toBe(failed);
    expect(openPackageActivationJournal(prepared.anchor).read().phase).toBe("publishing");
    expect(fs.existsSync(path.join(prepared.anchor, "previous"))).toBe(true);
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
  },
);

it.skipIf(process.platform === "win32")(
  "joins an unawaited forward publication before releasing the original owner",
  async () => {
    const f = await fixture();
    const reached = createDeferredCore();
    const returned = createDeferredCore();
    const resume = createDeferredCore();
    let settled = false;
    let publishing: Promise<unknown> | undefined;
    const rename = fsp.rename;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === f.packageRoot) {
        reached.resolve();
        await resume.promise;
      }
    });
    const operation = f
      .execute(async (fence) => {
        const prepared = await f.prepare(fence);
        publishing = prepared.publish(false);
        // The executor must join its native task; separately consume the retained
        // wrapper promise so a regression cannot hide as an unhandled rejection.
        void publishing.catch(() => {});
        await reached.promise;
        try {
          expect(fence.assertCurrent).toThrow(/unresolved/);
          expect(currentUpdateInitialStoreAdmission).toThrow(/publication has not settled/);
        } finally {
          returned.resolve();
        }
      })
      .finally(() => {
        settled = true;
        reached.resolve();
        returned.resolve();
      });
    try {
      await reached.promise;
      await returned.promise;
      expect(settled).toBe(false);
      expect(f.store.read(f.packageRoot).kind).toBe("current");
    } finally {
      resume.resolve();
      await operation;
      await publishing;
    }
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
    expect(
      JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
    ).toBe("2.0.0");
  },
);

it.skipIf(process.platform === "win32")(
  "releases its original native owner if the lexical invocation ends during publication",
  async () => {
    const f = await fixture();
    const reached = createDeferredCore();
    const resume = createDeferredCore();
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    let pending: Promise<void> | undefined;
    const rename = fsp.rename;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === f.packageRoot) {
        reached.resolve();
        await resume.promise;
      }
    });
    try {
      await withStateDatabaseCoordinatorRuntimeDirectory(f.coordinator, async () => {
        await maintenance.run(() =>
          withUpdateInitialStoreInvocation({ version: 1, selection: f.selection }, async () => {
            // Deliberately end the lexical caller while its admitted native executor
            // still owns publication. It must reject reopening, but join and release
            // its exact native owner before the separate maintenance scope closes.
            pending = withUpdateCommandExecutor(
              f.runId,
              async (executor) => {
                const fence = await executor.enter(f.packageRoot);
                const prepared = await f.prepare(fence);
                await prepared.publish(false);
              },
              {
                directOriginal: { databasePath: f.handoff },
                initialStores: { protocol: "initial-pair-v1", selection: f.selection },
              },
            );
            void pending.catch(() => {
              reached.resolve();
            });
            await reached.promise;
          }),
        );
        expect(f.store.read(f.packageRoot).kind).toBe("current");
        resume.resolve();
        await expect(pending).rejects.toThrow("Publication outlived its original invocation.");
      });
    } finally {
      resume.resolve();
      await pending?.catch(() => {});
      await maintenance.close();
    }
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
  },
);

it.skipIf(process.platform === "win32")(
  "does not revive a retired inline owner with a replacement original fence assertion",
  async () => {
    const f = await fixture();
    let retained!: Awaited<ReturnType<typeof f.prepare>>;
    let original!: UpdateRecoveryFence;
    await f.execute(async (fence) => {
      original = fence;
      retained = await f.prepare(fence);
      await retained.publish(false);
    });
    const before = retained.journal.read();
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
    original.assertCurrent = () => {};
    expect(() => retained.assertCurrent()).toThrow();
    await expect(retained.retire()).rejects.toThrow();
    expect(retained.journal.read()).toEqual(before);
    expect(identity(f.packageRoot)).toBe(before.descriptor.candidate.identity);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects provider dispatch from the caller while the original native publication is registered",
  async () => {
    const f = await fixture();
    await f.execute(async (fence) => {
      const prepared = await f.prepare(fence);
      const initial = prepared.journal.read();
      const original = prepared.publish(false);
      let foreign: Promise<unknown> | undefined;
      let refusal: unknown;
      try {
        const provider = createPackageActivationForwardProvider(
          prepared.anchor,
          prepared.journal,
          () => {},
          initial,
        );
        foreign = provider.publish(false);
      } catch (error) {
        refusal = error;
      }
      // A failing regression must still join both issued operations. The correct
      // implementation never issues the foreign operation at all.
      await Promise.allSettled([original, foreign]);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toMatch(/native dispatch/);
      expect((await original).phase).toBe("publication-complete");
      prepared.assertCurrent();
    });
    expect(f.store.read(f.packageRoot)).toEqual({ kind: "absent" });
  },
);
