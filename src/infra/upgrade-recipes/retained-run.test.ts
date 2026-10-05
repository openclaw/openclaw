import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createUpdateRun } from "../update-run-ledger.js";
import type { UpdateRecoveryFence } from "../update-run-recovery.js";
import type { UpgradeRecipeRecoveryPorts } from "./recovery.js";
import {
  createRetainedUpgradeRecipeRunStore,
  type RetainedUpgradeRecipeRunPointer,
} from "./retained-run.js";
import {
  readRetainedUpgradeRecipeRunInDatabase,
  recordRetainedUpgradeRecipeRunInWorker,
} from "./retained-run.worker.js";
const native = vi.hoisted(() => ({
  authority: {
    installKey: "",
    databasePath: "",
    databaseIdentity: "original-db",
    parentIdentity: "original-parent",
    owner: "original-owner",
  },
}));
vi.mock("../../cli/update-cli/update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/update-cli/update-command-executor.js")>()),
  captureUpdateCommandExecutorAuthority: () => native.authority,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);
async function fixture() {
  const root = dirs.make("recipe-retained-");
  await fs.chmod(root, 0o700);
  const state = path.join(root, "state"),
    install = path.join(root, "install"),
    workspace = path.join(root, "workspace"),
    evidence = path.join(root, "evidence"),
    runner = path.join(root, "runner");
  for (const directory of [state, install, workspace, evidence, runner]) {
    await fs.mkdir(directory, { mode: 0o700 });
  }
  const options = { env: { OPENCLAW_STATE_DIR: state } };
  const database = openOpenClawStateDatabase(options);
  const run = createUpdateRun({ trigger: "cli" }, options);
  const databasePath = database.path;
  closeOpenClawStateDatabaseForTest();
  const nativeDatabasePath = path.join(root, "native-leases.sqlite");
  await fs.writeFile(nativeDatabasePath, "native lease fixture", { mode: 0o600 });
  native.authority = { ...native.authority, installKey: install, databasePath: nativeDatabasePath };
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("fence retired");
    }
  };
  const store = createRetainedUpgradeRecipeRunStore({
    ...options,
    path: databasePath,
    assertCurrent,
  });
  const input = {
    fence: { assertCurrent } as UpdateRecoveryFence,
    runId: run.runId,
    originalCreatedAtMs: run.createdAtMs,
    root: evidence,
    forbiddenRoots: [workspace],
    envelope: {
      schemaVersion: 1 as const,
      binding: {
        protocol: 1 as const,
        runId: run.runId,
        planDigest: "a".repeat(64),
        targetArtifactId: "target",
        installationKey: install,
        stateRootKey: state,
      },
      runner: {
        root: runner,
        manifestDigest: "b".repeat(64),
        closureDigest: "c".repeat(64),
        runtimePath: path.join(runner, "node"),
        entrypointPath: path.join(runner, "main.mjs"),
      },
      stepBindings: [],
    },
    plan: Buffer.from("approved-plan"),
    config: Buffer.from("approved-config"),
    authorization: Buffer.from("durable-admission"),
  };
  const verifier: Omit<
    UpgradeRecipeRecoveryPorts,
    "readOriginalRun" | "readRetainedEnvelope" | "readArtifact"
  > = {
    verifyRetainedAuthorization: async () => {},
    verifyRetainedPlanAndConfig: async () => {},
    verifyRetainedRunner: async () => {
      throw new Error("not used by store test");
    },
    assertOriginalRecoveryOwner: async () => {},
    readReceipts: async () => ({ maintenance: null, steps: [] }),
  };
  const readDirect = () => {
    const db = openOpenClawStateDatabase({ ...options, path: databasePath });
    try {
      return readRetainedUpgradeRecipeRunInDatabase(db.db, run.runId);
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  };
  return {
    root,
    options,
    databasePath,
    store,
    input,
    verifier,
    readDirect,
    retire: () => {
      current = false;
    },
  };
}
it("persists private fsynced artifacts and original ledger pointer through typed workers", async () => {
  const f = await fixture();
  const { pointer, retained } = await f.store.retain(f.input);
  const ports = f.store.recoveryPorts(f.verifier);
  expect((await ports.readOriginalRun(f.input.runId))?.retainedEvidenceSha256).toBe(
    pointer.envelope.sha256,
  );
  expect(
    JSON.parse(Buffer.from(await ports.readRetainedEnvelope(f.input.runId)).toString()),
  ).toEqual(retained);
  expect(Buffer.from(await ports.readArtifact(retained.planArtifact)).toString()).toBe(
    "approved-plan",
  );
  expect((await fs.stat(pointer.envelope.path)).mode & 0o777).toBe(0o600);
  expect(pointer.nativeAuthority.databasePath).not.toBe(pointer.ledgerAuthority.databasePath);
  expect(pointer.ledgerAuthority.databasePath).toBe(f.databasePath);
  await expect(f.store.retain(f.input)).rejects.toThrow();
  expect(f.readDirect()?.pointer).toEqual(pointer);
});
it("refuses corrupted and symlink-substituted artifacts without changing the original pointer", async () => {
  const f = await fixture();
  const { pointer, retained } = await f.store.retain(f.input);
  const ports = f.store.recoveryPorts(f.verifier);
  await fs.writeFile(retained.planArtifact.path, "changed-plan");
  await expect(ports.readArtifact(retained.planArtifact)).rejects.toThrow();
  await fs.rename(pointer.envelope.path, `${pointer.envelope.path}.original`);
  await fs.symlink(`${pointer.envelope.path}.original`, pointer.envelope.path);
  await expect(ports.readRetainedEnvelope(f.input.runId)).rejects.toThrow("private canonical");
  expect(f.readDirect()?.pointer).toEqual(pointer);
});
it("does not adopt an orphan run directory and rejects installation/workspace retention", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.input.root, f.input.runId), { mode: 0o700 });
  await expect(f.store.retain(f.input)).rejects.toThrow();
  await expect(
    f.store.retain({ ...f.input, root: f.input.envelope.binding.installationKey }),
  ).rejects.toThrow("outside installations");
  await expect(f.store.retain({ ...f.input, root: f.input.forbiddenRoots[0]! })).rejects.toThrow(
    "outside installations",
  );
  await expect(
    f.store.recoveryPorts(f.verifier).readRetainedEnvelope(f.input.runId),
  ).rejects.toThrow("never adopt orphan");
  expect(f.readDirect()).toBeNull();
});
it("refuses replacement pointers, ledger correlation mismatch and commit fence loss", async () => {
  const f = await fixture();
  const { pointer } = await f.store.retain(f.input);
  const writeOptions = { ...f.options, path: f.databasePath };
  expect(recordRetainedUpgradeRecipeRunInWorker(pointer, writeOptions, () => {})).toEqual(pointer);
  await expect(
    Promise.resolve().then(() =>
      recordRetainedUpgradeRecipeRunInWorker(
        { ...pointer, envelope: { ...pointer.envelope, sha256: "d".repeat(64) } },
        writeOptions,
        () => {},
      ),
    ),
  ).rejects.toThrow("immutable");
  const g = await fixture();
  const stat = await fs.stat(g.databasePath);
  const parent = await fs.stat(path.dirname(g.databasePath));
  const proposed: RetainedUpgradeRecipeRunPointer = {
    ...pointer,
    runId: g.input.runId,
    originalCreatedAtMs: g.input.originalCreatedAtMs,
    ledgerAuthority: {
      databasePath: g.databasePath,
      databaseIdentity: `${stat.dev}:${stat.ino}`,
      parentIdentity: `${parent.dev}:${parent.ino}`,
    },
  };
  expect(() =>
    recordRetainedUpgradeRecipeRunInWorker(
      { ...proposed, originalCreatedAtMs: 0 },
      { ...g.options, path: g.databasePath },
      () => {},
    ),
  ).toThrow("exact original");
  expect(() =>
    recordRetainedUpgradeRecipeRunInWorker(
      proposed,
      { ...g.options, path: g.databasePath },
      (stage) => {
        if (stage === "commit") {
          throw new Error("lost fence");
        }
      },
    ),
  ).toThrow("lost fence");
  expect(g.readDirect()).toBeNull();
});
it("refuses native custody loss before writing any evidence", async () => {
  const f = await fixture();
  f.retire();
  await expect(f.store.retain(f.input)).rejects.toThrow("fence retired");
  expect(await fs.readdir(f.input.root)).toEqual([]);
});
