import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import {
  createPackageActivationJournal,
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
  type PackageActivationDescriptor,
} from "./package-update-activation-journal.js";
import type { PackageActivationReverseBinding } from "./package-update-activation-reverse-schema.js";
import * as runtimeWorker from "./runtime-worker-url.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const digest = "a".repeat(64);
const assertCurrent = () => {};
const start = { kind: "reverse", direction: "reverse", completed: 0, effect: null } as const;

function fixture(original = true) {
  const parent = process.env.OPENCLAW_LOWER_JOURNAL_TEST_ROOT ?? os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lower-journal-")));
  roots.push(root);
  const directory = (name: string) => {
    const value = path.join(root, name);
    fs.mkdirSync(value, { mode: 0o700 });
    return value;
  };
  const live = directory("live");
  const stage = directory("stage");
  const bin = directory("bin");
  const anchor = resolvePackageActivationAnchor(live);
  const stagedAnchor = directory(path.basename(anchor) + ".staged");
  const launchers = directory("launchers");
  const control = directory(path.basename(resolvePackageActivationControl(stagedAnchor)));
  const helper = resolvePackageActivationHelper(stagedAnchor);
  fs.writeFileSync(helper, "// original helper\n", { mode: 0o600 });
  const temporary = directory("private-tmp");
  const { databasePath: handoff, assertDatabasePath } = installPrivateUpdateHandoffStore(temporary);
  assertDatabasePath(handoff);
  const childGuardEnv = writePrivateUpdateHandoffChildGuard(handoff, temporary);
  const state = directory("private-state");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
  const handoffDb = new DatabaseSync(handoff);
  handoffDb.close();
  fs.chmodSync(handoff, 0o600);
  const id = (p: string, dir = true) => packageActivationIdentity(p, dir);
  const operationId = randomUUID();
  const runId = "original-run";
  const runtime = {
    packageManifestSha256: digest,
    buildInfoSha256: digest,
    buildId: "build-original",
    sourceCommit: "a".repeat(40),
    inventoryDigest: digest,
    nodeVersion: process.version,
    nodePath: path.join(root, "external-node"),
    node: {
      kind: "file" as const,
      identity: "1:2",
      uid: "1",
      gid: "1",
      mode: 0o700,
      sha256: digest,
      size: 1,
    },
    entrypoint: "dist/entry.js",
    entrypointSha256: digest,
  };
  const descriptor: Omit<PackageActivationDescriptor, "journalIdentity"> = {
    version: 1,
    layout: "external-helper",
    operationId,
    ...(original ? { originalRunId: runId, previousRuntime: runtime } : {}),
    authority: {
      databasePath: handoff,
      databaseIdentity: id(handoff, false),
      parentIdentity: id(root),
      installKey: live,
      owner: "original-owner",
    },
    anchorIdentity: id(stagedAnchor),
    journalParentIdentity: id(control),
    parentIdentity: id(root),
    binDir: bin,
    binIdentity: id(bin),
    originalStageRoot: stage,
    previous: { digest, identity: id(live), version: "1.0.0" },
    candidate: { digest: "b".repeat(64), identity: id(stage), version: "2.0.0" },
    launcherRootIdentity: id(launchers),
    previousLauncherRootIdentity: null,
    helperIdentity: id(helper, false),
    helperDigest: createHash("sha256").update(fs.readFileSync(helper)).digest("hex"),
    launchers: [],
    preparation: [
      {
        name: "anchor",
        source: stagedAnchor,
        sourceParentIdentity: id(root),
        identity: id(stagedAnchor),
      },
      {
        name: "helper",
        source: resolvePackageActivationHelper(anchor),
        sourceParentIdentity: id(control),
        identity: id(helper, false),
      },
      { name: "candidate", source: stage, sourceParentIdentity: id(root), identity: id(stage) },
      {
        name: "launchers",
        source: launchers,
        sourceParentIdentity: id(root),
        identity: id(launchers),
      },
    ],
  };
  const journal = createPackageActivationJournal(anchor, descriptor, control, assertCurrent);
  fs.renameSync(stagedAnchor, anchor);
  const record = journal.transition(journal.read(), "publication-complete", null, assertCurrent);
  const ref = (name: string) => ({
    directory: path.join(root, name),
    manifestPath: path.join(root, name, "manifest.json"),
    manifestSha256: digest,
  });
  const binding: PackageActivationReverseBinding = {
    protocol: "package-state-reverse-v1",
    operationId,
    runId,
    baseline: ref("B"),
    candidate: ref("C"),
    prepared: ref("T"),
    sourceAttestation: { path: path.join(root, "captured-source.json"), sha256: digest },
    target: { ...runtime, admissionSha256: digest, startupProtocol: "package-state-reverse-v1" },
    initialStores: {
      privateRoot: { path: root, identity: id(root) },
      installation: { path: live, identity: descriptor.candidate.identity },
      handoff: {
        databasePath: descriptor.authority.databasePath,
        databaseIdentity: descriptor.authority.databaseIdentity,
        parentIdentity: descriptor.authority.parentIdentity,
      },
      state: {
        databasePath: path.join(root, "state.sqlite"),
        databaseIdentity: id(root),
        parentIdentity: id(root),
      },
    },
    resources: [
      {
        role: "state",
        live: path.join(root, "state.sqlite"),
        parentIdentity: id(root),
        before: { kind: "missing" },
        after: { kind: "missing" },
        move: null,
      },
    ],
  };
  return {
    root,
    childGuardEnv,
    anchor,
    journal,
    record,
    binding,
    journalPath: resolvePackageActivationJournalPath(anchor),
  };
}

it("pins exact source reference once and retains it through durable reverse progress and reopen", () => {
  const f = fixture();
  const admitted = f.journal.transition(
    f.record,
    "reverse-in-progress",
    start,
    assertCurrent,
    [],
    f.binding,
  );
  expect(openPackageActivationJournal(f.anchor).read().descriptor.reverse).toEqual(f.binding);
  const saved = structuredClone(f.binding.sourceAttestation);
  f.binding.sourceAttestation.path = path.join(f.root, "reissued.json");
  expect(
    openPackageActivationJournal(f.anchor).read().descriptor.reverse?.sourceAttestation,
  ).toEqual(saved);
  const completed = f.journal.transition(
    admitted,
    "reverse-complete",
    { ...start, completed: 1 },
    assertCurrent,
  );
  const settled = f.journal.transition(
    completed,
    "rolled-back",
    { ...start, completed: 1 },
    assertCurrent,
  );
  expect(settled.revision).toBe(f.record.revision + 3);
  expect(openPackageActivationJournal(f.anchor).read()).toEqual(settled);
  expect(settled.descriptor.authority).toEqual(f.record.descriptor.authority);
});

it("refuses foreign run/operation, missing proof ref and wrong admission phase without a durable transition", () => {
  const f = fixture();
  for (const binding of [
    { ...f.binding, runId: "foreign-run" },
    { ...f.binding, operationId: randomUUID() },
    { ...f.binding, sourceAttestation: undefined },
  ]) {
    expect(() =>
      f.journal.transition(
        f.record,
        "reverse-in-progress",
        start,
        assertCurrent,
        [],
        binding as PackageActivationReverseBinding,
      ),
    ).toThrow();
    expect(f.journal.read()).toEqual(f.record);
  }
  const prepared = f.journal.transition(f.record, "prepared", null, assertCurrent);
  expect(() =>
    f.journal.transition(prepared, "reverse-in-progress", start, assertCurrent, [], f.binding),
  ).toThrow("only be committed once");
  expect(f.journal.read()).toEqual(prepared);
});

it("refuses replacement bindings, forward rearming, missing progress and premature reverse completion", () => {
  const f = fixture();
  const admitted = f.journal.transition(
    f.record,
    "reverse-in-progress",
    start,
    assertCurrent,
    [],
    f.binding,
  );
  expect(() =>
    f.journal.transition(admitted, "reverse-in-progress", start, assertCurrent, [], f.binding),
  ).toThrow("only be committed once");
  expect(() => f.journal.transition(admitted, "publishing", null, assertCurrent)).toThrow(
    "original operation phase",
  );
  expect(() => f.journal.transition(admitted, "reverse-in-progress", null, assertCurrent)).toThrow(
    "no durable binding/progress",
  );
  expect(() => f.journal.transition(admitted, "reverse-complete", start, assertCurrent)).toThrow(
    "incomplete",
  );
  expect(() =>
    f.journal.transition(
      admitted,
      "reverse-in-progress",
      { ...start, completed: 2 },
      assertCurrent,
    ),
  ).toThrow("incomplete");
  expect(f.journal.read()).toEqual(admitted);
});

it("rolls back pinning on last-moment authority loss and rejects stale expected records", () => {
  const f = fixture();
  let calls = 0;
  expect(() =>
    f.journal.transition(
      f.record,
      "reverse-in-progress",
      start,
      () => {
        if (++calls === 3) {
          throw new Error("original authority revoked at commit");
        }
      },
      [],
      f.binding,
    ),
  ).toThrow("revoked at commit");
  expect(calls).toBe(3);
  expect(f.journal.read()).toEqual(f.record);
  const admitted = f.journal.transition(
    f.record,
    "reverse-in-progress",
    start,
    assertCurrent,
    [],
    f.binding,
  );
  expect(() =>
    f.journal.transition(f.record, "reverse-in-progress", start, assertCurrent, [], f.binding),
  ).toThrow("no longer current");
  expect(f.journal.read()).toEqual(admitted);
});

it("keeps legacy journals readable but does not manufacture original reverse run identity", () => {
  const f = fixture(false);
  expect(f.journal.read().descriptor.originalRunId).toBeUndefined();
  expect(() =>
    f.journal.transition(f.record, "reverse-in-progress", start, assertCurrent, [], f.binding),
  ).toThrow("only be committed once");
  expect(f.journal.read()).toEqual(f.record);
  expect(f.journal.transition(f.record, "rollback-in-progress", null, assertCurrent).phase).toBe(
    "rollback-in-progress",
  );
});

it("recovers an interrupted reverse-progress write without replacing the sealed source reference", async () => {
  const f = fixture();
  const admitted = f.journal.transition(
    f.record,
    "reverse-in-progress",
    start,
    assertCurrent,
    [],
    f.binding,
  );
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN IMMEDIATE');
    db.prepare('UPDATE package_activation SET revision=revision+1, descriptor_json=?').run('x'.repeat(200000));
    process.kill(process.pid, 'SIGKILL');
  `,
      f.journalPath,
    ],
    {
      env: f.childGuardEnv({ ...process.env, HOME: f.root, USERPROFILE: f.root }),
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal, child.stderr).toBe("SIGKILL");
  const sidecar = `${f.journalPath}-journal`;
  expect(fs.statSync(sidecar).size).toBeGreaterThan(0);
  const before = [f.journalPath, sidecar].map((file) => fs.readFileSync(file));
  const coordinator = path.join(f.root, "coordinator");
  fs.mkdirSync(coordinator, { mode: 0o700 });
  // The snapshot worker owns a separate ALS lifetime. Select its private
  // coordinator in that actual process, before importing the real worker entry.
  const worker = runtimeWorker.resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-readonly-location.worker",
    distWorkerPath: "infra/sqlite-readonly-location.worker.js",
  });
  const wrapper = path.join(f.root, "snapshot-private.worker.mts");
  const coordinatorModule = fileURLToPath(
    new URL("./state-database-coordinator.ts", import.meta.url),
  );
  const guard = path.join(f.root, "private-tmp", "private-handoff-guard.cjs");
  fs.writeFileSync(
    wrapper,
    `import { createRequire } from "node:module";
createRequire(import.meta.url)(${JSON.stringify(guard)});
const { withStateDatabaseCoordinatorRuntimeDirectory } = await import(${JSON.stringify(pathToFileURL(coordinatorModule).href)});
await withStateDatabaseCoordinatorRuntimeDirectory({directory:${JSON.stringify(coordinator)},keepAlive:false}, async () => { await import(${JSON.stringify(worker.href)}); });`,
  );
  const resolveWorker = runtimeWorker.resolveRuntimeWorkerUrl;
  vi.spyOn(runtimeWorker, "resolveRuntimeWorkerUrl").mockImplementation((entry) =>
    entry.sourceWorkerName === "sqlite-readonly-location.worker"
      ? pathToFileURL(wrapper)
      : resolveWorker(entry),
  );
  await withStateDatabaseCoordinatorRuntimeDirectory(
    { directory: coordinator, keepAlive: false },
    async () => {
      const recovery = await openPackageActivationJournal(f.anchor).readForRecovery();
      expect(recovery.record).toEqual(admitted);
      expect([f.journalPath, sidecar].map((file) => fs.readFileSync(file))).toEqual(before);
      expect(() =>
        recovery.admit(() => {
          throw new Error("recovery authority revoked");
        }),
      ).toThrow("revoked");
      expect([f.journalPath, sidecar].map((file) => fs.readFileSync(file))).toEqual(before);
      recovery.admit(assertCurrent);
      expect(openPackageActivationJournal(f.anchor).read()).toEqual(admitted);
      expect(
        openPackageActivationJournal(f.anchor).read().descriptor.reverse?.sourceAttestation,
      ).toEqual(f.binding.sourceAttestation);
    },
  );
});
