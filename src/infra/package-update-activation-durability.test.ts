import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import * as durability from "./directory-durability.js";
import * as nodeSqlite from "./node-sqlite.js";
import { withDatabase } from "./package-update-activation-fixtures.test-support.js";
import {
  openPackageActivationJournal,
  type PackageActivationIntent,
  type PackageActivationPhase,
  type PackageActivationRecord,
  resolvePackageActivationControl as control,
  resolvePackageActivationJournalPath as journalPath,
  resolvePackageActivationHelper as helperPath,
} from "./package-update-activation-journal.js";
import {
  createPackageActivationLifetimeFixture,
  snapshotActivationFiles,
} from "./package-update-activation-lifetime.test-support.js";
import {
  capturePackageActivationRuntime,
  resolvePackageActivationAnchor,
} from "./package-update-activation-paths.js";
import { preparePackageActivationJournal } from "./package-update-activation-prepare.js";
import {
  readPackageActivationStatus as status,
  runPackageActivationRecovery as recovery,
} from "./package-update-activation.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import {
  runPublicationSwap,
  withPublicationFence,
} from "./package-update-publication.test-support.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const fixture = createPackageActivationLifetimeFixture();
let root: string;
let anchor: string;
let assertDatabasePath: (path: string) => void;
let childGuardEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
beforeEach(() => {
  ({ root, assertDatabasePath, childGuardEnv } = fixture.setup());
  anchor = "";
});
afterEach(async () => fixture.cleanup());

describe.skipIf(process.platform === "win32")("package fingerprint bounds", () => {
  beforeEach(() => {
    const state = path.join(root, "state");
    fs.mkdirSync(state, { mode: 0o700 });
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
  });
  function oversizedFile(payload: string, firstRegularOnly = false) {
    const lstat = fsp.lstat.bind(fsp);
    let observed = false;
    vi.spyOn(fsp, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (
        String(args[0]) === payload &&
        args[1]?.bigint &&
        (!firstRegularOnly || (!observed && stat.isFile()))
      ) {
        stat.size = 8n * 1024n * 1024n * 1024n + 1n;
        observed = true;
      }
      return stat;
    });
    return () => expect(observed).toBe(true);
  }
  it("activates after candidate byte exhaustion while retaining identity, version, and launcher checks", () =>
    fixture.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixture.writePostCoreCapability(f.params.stage.packageRoot);
      const payload = path.join(f.params.stage.packageRoot, "a-oversized.bin");
      await fsp.writeFile(payload, "");
      const location = resolvePackageActivationAnchor(f.packageRoot);
      // Exhaust the budget before candidate hashing, but only on its first regular file.
      const assertOversized = oversizedFile(payload, true);
      await withPublicationFence(f.packageRoot, async (fence) => {
        const { result, transaction } = await runPublicationSwap(f, fence);
        expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
        assertOversized();
        expect(result.step.advisory?.message).toContain("full package contents are unverified");
        expect(updateRunStepsFromResultStep(result.step)).toContainEqual(
          expect.objectContaining({ step: "warning:package-swap", status: "completed" }),
        );
        expect(transaction).toBeDefined();
      });
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
      const manifest = path.join(f.packageRoot, "package.json");
      const originalManifest = fs.readFileSync(manifest);
      expect(JSON.parse(originalManifest.toString()).version).toBe("2.0.0");
      const record = readJournal(location);
      expect(record.phase).toBe("publication-complete");
      const retire = () => recovery(location, "retire", record.descriptor.operationId);
      const retained = path.join(root, "retained-candidate");
      fs.renameSync(f.packageRoot, retained);
      fs.mkdirSync(f.packageRoot);
      fs.writeFileSync(manifest, originalManifest);
      await expect(retire()).rejects.toThrow("Package publication object changed");
      fs.unlinkSync(manifest);
      fs.rmdirSync(f.packageRoot);
      fs.renameSync(retained, f.packageRoot);
      fs.writeFileSync(manifest, '{"name":"openclaw","version":"3.0.0"}');
      await expect(retire()).rejects.toThrow("Package publication object changed");
      fs.writeFileSync(manifest, originalManifest);
      fs.writeFileSync(f.launcher, "changed launcher\n");
      await expect(retire()).rejects.toThrow("Selected package launcher fingerprint changed");
      fs.writeFileSync(f.launcher, "candidate launcher\n");
      await complete(retire());
      absent(location);
    }));
  it("keeps full fingerprint recovery strict when content verification exceeds its budget", () =>
    fixture.lifetime.run(async () => {
      const f = await fixture.prepare();
      const assertOversized = oversizedFile(path.join(f.anchor, "candidate", "dist", "index.js"));
      await expect(recovery(f.anchor, "repair", f.operationId)).rejects.toThrow(
        "Package rollback verification byte limit exceeded",
      );
      assertOversized();
      expect(readJournal(f.anchor).phase).toBe("prepared");
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
    }));
});

const prepare = (custody?: (retained: boolean) => void) =>
  fixture.prepare((value) => {
    anchor = value;
  }, custody);
const readJournal = (location = anchor) => openPackageActivationJournal(location).read();
const absent = (...files: string[]) =>
  files.forEach((file) => expect(fs.existsSync(file)).toBe(false));
const oldPackage = (directory: string) =>
  expect(fs.readFileSync(path.join(directory, "package.json"), "utf8")).toContain(
    '"version":"1.0.0"',
  );
const complete = (result: ReturnType<typeof recovery>) =>
  expect(result).resolves.toMatchObject({ phase: "complete" });
function expectHelperUnlink(location: string) {
  const record = readJournal(location);
  expect(record).toMatchObject({
    phase: "anchor-retired",
    intent: { kind: "unlink-helper", identity: record.descriptor.helperIdentity },
  });
}
async function recover(location: string) {
  const { operationId } = readJournal(location).descriptor;
  await expect(recovery(location, "repair", operationId)).resolves.toMatchObject({
    phase: "aborted",
  });
  await complete(recovery(location, "retire", operationId));
  absent(location, helperPath(location));
}

describe.skipIf(process.platform === "win32")("package preparation durability", () => {
  it.each(["before-probe", "during-probe", "unsupported-bun"] as const)(
    "refuses %s runtime before custody",
    async (cut) => {
      const f = await createPackageSwapFixture(root);
      const executable = path.join(root, "selected-runtime");
      fs.writeFileSync(executable, "fixture runtime", { mode: 0o700 });
      const runtime = capturePackageActivationRuntime("bun", executable);
      if (cut === "before-probe") {
        fs.renameSync(executable, `${executable}.previous`);
        fs.writeFileSync(executable, "fixture runtime", { mode: 0o700 });
      }
      vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockImplementation(async () => {
        if (cut === "during-probe") {
          fs.writeFileSync(executable, "changed runtime executable");
        }
        return {
          status: cut === "unsupported-bun" ? "unsupported" : "supported",
          version: cut === "unsupported-bun" ? "1.3.0" : "1.4.3",
          sqliteVersion: "3.53.4",
          sqliteProbe: {
            available: true,
            version: "3.53.4",
            text: true,
            blob: true,
            json: true,
          },
          nodeSharedSqlite: false,
        };
      });
      anchor = resolvePackageActivationAnchor(f.packageRoot);
      const onPrepared = vi.fn();
      const onCustody = vi.fn();
      const reader = createPackageIntegrityReader();
      const previous = await reader.tree(f.packageRoot);
      const candidate = await reader.tree(f.params.stage.packageRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await expect(
          preparePackageActivationJournal({
            options: { fence: await executor.enter(f.packageRoot), runtime, onPrepared },
            liveRoot: f.packageRoot,
            stageRoot: f.params.stage.packageRoot,
            launcherRoot: f.params.stage.layout.binDir,
            binDir: path.dirname(f.launcher),
            previous,
            onCustody,
            launchers: [],
          }),
        ).rejects.toThrow(
          cut === "unsupported-bun"
            ? "supported external Bun executable"
            : "changed after runtime preflight",
        );
      });
      expect(onPrepared).not.toHaveBeenCalled();
      expect(onCustody).not.toHaveBeenCalled();
      absent(anchor, control(anchor));
      expect(await reader.tree(f.packageRoot)).toEqual(previous);
      expect(await reader.tree(f.params.stage.packageRoot)).toEqual(candidate);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
    },
  );

  it.each([
    "anchor-before",
    "anchor-after",
    "anchor-sync",
    "helper-before",
    "helper-after",
    "helper-sync",
  ])("recovers the exact %s terminal cut", async (cut) => {
    const f = await fixture.prepare();
    await recovery(f.anchor, "repair", f.operationId);
    const helper = helperPath(f.anchor);
    const [target, moment] = cut.split("-");
    const removed = target === "anchor" ? f.anchor : helper;
    const read = () => readJournal(f.anchor);
    const retire = () => recovery(f.anchor, "retire", f.operationId);
    const inspect = () => status(f.anchor, f.operationId);
    const failure = new Error(cut);
    const rmdir = fsp.rmdir.bind(fsp),
      unlink = fsp.unlink.bind(fsp);
    let refuseSync = true,
      anchorSyncRefusals = 0;
    let helperSync: durability.DirectorySyncOutcome | undefined;
    const remove = async (
      kind: "anchor" | "helper",
      file: unknown,
      effect: () => Promise<void>,
    ) => {
      if (kind === target && file === removed && moment !== "sync") {
        if (target === "helper") {
          expectHelperUnlink(f.anchor);
        }
        if (moment === "after") {
          await effect();
        }
        throw failure;
      }
      await effect();
    };
    vi.spyOn(fsp, "rmdir").mockImplementation((file, ...args) =>
      remove("anchor", file, () => rmdir(file, ...args)),
    );
    vi.spyOn(fsp, "unlink").mockImplementation((file) =>
      remove("helper", file, () => unlink(file)),
    );
    const sync = durability.syncDirectory;
    const syncSpy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      if (moment === "sync" && directory === path.dirname(removed) && !fs.existsSync(removed)) {
        if (target === "anchor") {
          expect(read()).toMatchObject({
            phase: "retiring",
            intent: { kind: "remove-anchor", selected: "previous" },
          });
        } else {
          expectHelperUnlink(f.anchor);
        }
        if (refuseSync) {
          if (target === "anchor") {
            anchorSyncRefusals++;
          }
          throw target === "helper" ? Object.assign(failure, { code: "EIO" }) : failure;
        }
        const result = await sync(directory);
        if (target === "helper") {
          helperSync = result;
        }
        return result;
      }
      return sync(directory);
    });
    await expect(retire()).rejects.toBe(failure);
    vi.mocked(fsp.rmdir).mockRestore();
    vi.mocked(fsp.unlink).mockRestore();
    if (moment === "sync") {
      const pending = read();
      if (cut === "anchor-sync") {
        expect(fs.existsSync(f.anchor)).toBe(false);
        expect(fs.existsSync(helper)).toBe(true);
      }
      await expect(retire()).rejects.toBe(failure);
      if (cut === "helper-sync") {
        await complete(inspect());
      } else {
        expect(anchorSyncRefusals).toBe(2);
      }
      expect(read()).toEqual(pending);
      refuseSync = false;
    }
    await complete(retire());
    if (cut === "helper-sync") {
      expect(helperSync).toEqual({ status: "synced" });
    } else if (cut === "anchor-sync") {
      absent(helper);
      oldPackage(f.packageRoot);
    }
    syncSpy.mockRestore();
    await complete(inspect());
    absent(f.anchor);
  });

  it.each(["source", "destination"] as const)("retries unpersisted %s custody", async (side) => {
    const failure = new Error("directory persistence failed");
    const sync = durability.syncDirectory;
    let refused = 0;
    const spy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      if (anchor && fs.existsSync(path.join(anchor, "candidate"))) {
        const record = readJournal();
        const candidate = record.descriptor.preparation.find(
          (entry) => entry.name === "candidate",
        )!;
        const parent = side === "source" ? path.dirname(candidate.source) : anchor;
        if (
          directory === parent &&
          record.intent?.kind === "prepare" &&
          record.intent.moving === "candidate"
        ) {
          expect(record.intent.completed).not.toContain("candidate");
          expect(fs.existsSync(candidate.source)).toBe(false);
          refused++;
          throw failure;
        }
      }
      return sync(directory);
    });
    await expect(prepare()).rejects.toBe(failure);
    const journal = openPackageActivationJournal(anchor);
    const before = journal.read();
    expect(before).toMatchObject({
      phase: "preparing",
      intent: { kind: "prepare", moving: "candidate" },
    });
    // The rename has already happened. Reconciliation must still require its
    // durability and leave the completion row unchanged on another failure.
    await expect(recovery(anchor, "repair", before.descriptor.operationId)).rejects.toBe(failure);
    expect(refused).toBe(2);
    expect(journal.read()).toEqual(before);
    spy.mockRestore();
    await recover(anchor);
    oldPackage(before.descriptor.authority.installKey);
  });

  it.each(["private", "published"] as const)("handles %s control sync failure", async (cut) => {
    const failure = new Error("control persistence failed");
    const custody = vi.fn();
    const sync = durability.syncDirectorySync;
    const spy = vi.spyOn(durability, "syncDirectorySync").mockImplementation((directory) => {
      if (
        anchor &&
        ((cut === "private" &&
          typeof directory === "string" &&
          path.basename(directory).startsWith(".activation-control-")) ||
          (cut === "published" &&
            directory === path.dirname(anchor) &&
            fs.existsSync(control(anchor))))
      ) {
        throw failure;
      }
      return sync(directory);
    });
    await expect(prepare(custody)).rejects.toBe(failure);
    spy.mockRestore();
    if (cut === "private") {
      expect(custody).not.toHaveBeenCalled();
      absent(control(anchor));
    } else {
      expect(custody.mock.calls).toEqual([[true]]);
      expect(readJournal().phase).toBe("preparing");
      await recover(anchor);
    }
  });

  it.each([false, true])("rejects unpersisted helper (replacement=%s)", async (replacement) => {
    const first = replacement ? await fixture.prepare() : undefined;
    if (first) {
      await recover(first.anchor);
    }
    const before = first && readJournal(first.anchor);
    const previousReceipt = first && fs.readFileSync(journalPath(first.anchor));
    let helperFd: number | undefined;
    let helperIdentity: fs.BigIntStats | undefined;
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const failure = new Error("helper persistence failed");
    const custody = vi.fn();
    vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      const fd = open(file, ...args);
      if (String(file).endsWith(".mjs") && String(file).includes(".activation-")) {
        helperFd = fd;
        helperIdentity = fs.fstatSync(fd, { bigint: true });
      }
      return fd;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fd === helperFd && helperIdentity) {
        const current = fs.fstatSync(fd, { bigint: true });
        // A closed helper fd can be reused by unrelated cleanup writes.
        if (current.dev === helperIdentity.dev && current.ino === helperIdentity.ino) {
          throw failure;
        }
      }
      sync(fd);
    });
    await expect(prepare(custody)).rejects.toBe(failure);
    expect(helperFd).toBeTypeOf("number");
    expect(() => fs.fstatSync(helperFd!)).toThrow();
    expect(custody).not.toHaveBeenCalled();
    if (before) {
      expect(
        fs.readFileSync(
          `${anchor}.superseded-${before.descriptor.operationId}/control/operation.sqlite`,
        ),
      ).toEqual(previousReceipt);
    }
    absent(control(anchor));
  });
});

it("refuses foreign or aliased handoff and state paths before opening any store", () => {
  for (const livePath of [
    "/tmp/openclaw/managed-update-handoffs.sqlite",
    "/private/tmp/openclaw/managed-update-handoffs.sqlite",
  ]) {
    expect(() => assertDatabasePath(livePath)).toThrow();
  }
  const privatePath = path.join(root, "private-tmp", "managed-update-handoffs.sqlite");
  expect(() => assertDatabasePath(privatePath)).not.toThrow();
  const env = childGuardEnv(process.env);
  // Use another owned fixture as the refusal target; a broken guard must never
  // open the developer's live state store while proving this boundary.
  const foreignDirectory = fs.realpathSync(
    fixture.lifetime.createTempDir("package-activation-foreign-state-"),
  );
  const foreignState = path.join(foreignDirectory, "openclaw-state.sqlite");
  const alias = path.join(root, "foreign-state");
  fs.symlinkSync(foreignDirectory, alias, "junction");
  const danglingTarget = path.join(foreignDirectory, "dangling-state.sqlite");
  const danglingAlias = path.join(root, "dangling-state.sqlite");
  // Windows directory aliases use unprivileged junctions. A dangling file
  // symlink needs extra OS privilege, so exercise that POSIX-specific cut here.
  if (process.platform !== "win32") {
    fs.symlinkSync(danglingTarget, danglingAlias, "file");
  }
  const foreignNested = path.join(foreignDirectory, "nested");
  fs.mkdirSync(foreignNested);
  const nestedAlias = path.join(root, "foreign-nested");
  fs.symlinkSync(foreignNested, nestedAlias, "junction");
  // Do not use path.join: it would erase the traversal this case must exercise.
  const traversedState = `${nestedAlias}${path.sep}..${path.sep}traversed-state.sqlite`;
  const refusedPaths = [
    "/tmp/openclaw/managed-update-handoffs.sqlite",
    "/private/tmp/openclaw/managed-update-handoffs.sqlite",
    foreignState,
    path.join(alias, "openclaw-state.sqlite"),
    ...(process.platform !== "win32" ? [danglingAlias] : []),
    traversedState,
    `file:${traversedState}`,
    `file:${traversedState.replace(`${path.sep}..${path.sep}`, `${path.sep}%2e%2e${path.sep}`)}`,
  ];
  const requireGuard = `require('node:assert/strict').equal(globalThis[Symbol.for('openclaw.test.privateHandoffGuard')], ${JSON.stringify(privatePath)});`;
  const probe = (file: string, close = false) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        `${requireGuard}new (require('node:sqlite').DatabaseSync)(${JSON.stringify(file)})${close ? ".close()" : ""}`,
      ],
      { env, encoding: "utf8" },
    );
  // The guard assertion runs before each attempt to open an untrusted path.
  const blockedResults = refusedPaths.map((file) => probe(file));
  for (const blocked of blockedResults) {
    expect(blocked.error).toBeUndefined();
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("ERR_ASSERTION");
  }
  for (const foreignPath of [
    foreignState,
    danglingTarget,
    path.join(foreignDirectory, "traversed-state.sqlite"),
  ]) {
    expect(fs.existsSync(foreignPath)).toBe(false);
  }
  for (const privateDatabase of [privatePath, path.join(root, "openclaw-state.sqlite")]) {
    const accepted = probe(privateDatabase, true);
    expect(accepted.error).toBeUndefined();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.realpathSync(privateDatabase)).toBe(privateDatabase);
    for (const uri of [
      nodeSqlite.resolveExistingSqliteFileUri(privateDatabase),
      nodeSqlite.resolveImmutableSqliteFileUri(privateDatabase),
    ]) {
      const reopened = probe(uri, true);
      expect(reopened.error).toBeUndefined();
      expect(reopened.status, reopened.stderr).toBe(0);
    }
  }
});

async function preparedJournal() {
  const f = await fixture.prepare();
  const journal = openPackageActivationJournal(f.anchor);
  const record = journal.read();
  const authority = record.descriptor.authority;
  const transition = (
    previous: PackageActivationRecord,
    phase: PackageActivationPhase,
    intent: PackageActivationIntent,
  ) =>
    withUpdateCommandExecutor(
      randomUUID(),
      async (executor) =>
        journal.transition(
          previous,
          phase,
          intent,
          (await executor.enter(f.packageRoot)).assertCurrent,
        ),
      { existingAuthority: authority },
    );
  return {
    ...f,
    journal,
    record,
    authority,
    transition,
    journalPath: journalPath(f.anchor),
  };
}

const journalFiles = (location: string) => snapshotActivationFiles(control(location));

function replaceField(
  file: string,
  column: "descriptor_json" | "revision" | "phase" | "intent_json" | "publications_json",
  value: string | number,
) {
  withDatabase(file, (db) =>
    db.prepare(`UPDATE package_activation SET ${column} = ? WHERE slot = 1`).run(value),
  );
}

function createHotJournal(file: string) {
  createHotSqliteRollbackJournal({
    path: file,
    mutationSql: "UPDATE package_activation SET phase = 'publication-complete'",
    env: childGuardEnv({}),
  });
}

describe.skipIf(process.platform === "win32")("package activation journal", () => {
  let f: Awaited<ReturnType<typeof preparedJournal>>;
  beforeEach(async () => {
    f = await preparedJournal();
  });
  it("keeps unsafe journal link details local and reports the code without changing recovery evidence", async () => {
    const file = f.journalPath;
    fs.linkSync(file, path.join(root, "retained-journal.sqlite"));
    const before = journalFiles(f.anchor);
    const observed = fs.lstatSync(file);
    let failure: unknown;
    try {
      openPackageActivationJournal(f.anchor);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const fact = createUpdateErrorFact("package-swap", failure);
    const expected = [
      "Package recovery journal",
      JSON.stringify(file),
      `mode=0${(observed.mode & 0o777).toString(8)}`,
      `nlink=${observed.nlink}`,
      `uid=${observed.uid}`,
      "expected nlink=1",
      "openclaw doctor --fix",
    ];
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "recovery-permissions",
        result: {
          mode: "npm",
          status: "error",
          durationMs: 1,
          steps: [
            {
              name: "package-swap",
              command: "",
              cwd: "",
              durationMs: 1,
              exitCode: 1,
              failureFacts: [fact],
            },
          ],
        },
      },
      { env: {}, stateDir: root },
    );
    for (const text of expected) {
      expect(failure).toMatchObject({ message: expect.stringContaining(text) });
    }
    expect(report.body).toContain(
      "Failing check package-swap (package-recovery-permissions-unsafe)",
    );
    expect(report.body).not.toContain(fact.message);
    expect(fact.message!.length).toBeLessThanOrEqual(200);
    expect(report.body).not.toContain(root);
    expect(journalFiles(f.anchor)).toEqual(before);
    expect(fs.lstatSync(file)).toMatchObject({ nlink: observed.nlink, mode: observed.mode });
  });

  it.each([false, true])(
    "preserves a hot journal until recovery admission (replaced=%s)",
    async (replaced) => {
      createHotJournal(f.journalPath);
      const rollbackPath = `${f.journalPath}-journal`;
      expect(fs.statSync(rollbackPath).size).toBeGreaterThan(512);
      const before = journalFiles(f.anchor);
      withDatabase(
        f.journalPath,
        (db) => {
          expect(() => db.prepare("SELECT phase FROM package_activation").get()).toThrow(
            expect.objectContaining({ errcode: 776 }),
          );
        },
        true,
      );
      await expect(status(f.anchor, f.operationId)).rejects.toThrow();
      expect(journalFiles(f.anchor)).toEqual(before);
      expect(fs.existsSync(`${f.journalPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${f.journalPath}-shm`)).toBe(false);

      const admission = await f.journal.readForRecovery();
      expect(admission.record).toEqual(f.record);
      expect(journalFiles(f.anchor)).toEqual(before);
      await expect(recovery(f.anchor, "repair", randomUUID())).rejects.toThrow(
        "different operation",
      );
      expect(journalFiles(f.anchor)).toEqual(before);
      const rollback = fs.readFileSync(rollbackPath);
      if (replaced) {
        const replacement = path.join(path.dirname(f.journalPath), "replacement.sqlite");
        fs.copyFileSync(f.journalPath, replacement);
        fs.renameSync(replacement, f.journalPath);
      }
      await withUpdateCommandExecutor(
        randomUUID(),
        async (executor) => {
          const fence = await executor.enter(f.packageRoot);
          if (replaced) {
            expect(() => admission.admit(fence.assertCurrent)).toThrow("changed");
          } else {
            admission.admit(fence.assertCurrent);
          }
        },
        { existingAuthority: f.authority },
      );
      if (replaced) {
        expect(fs.readFileSync(rollbackPath)).toEqual(rollback);
      } else {
        expect(f.journal.read()).toEqual(f.record);
        expect(fs.existsSync(rollbackPath)).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "status refuses foreign WAL without touching its files (liveWriter=%s)",
    async (liveWriter) => {
      const database = new DatabaseSync(f.journalPath);
      try {
        database.exec("PRAGMA journal_mode = WAL");
        if (liveWriter) {
          database.exec("UPDATE package_activation SET revision = revision + 1; BEGIN IMMEDIATE");
          expect(fs.statSync(`${f.journalPath}-wal`).size).toBeGreaterThan(0);
        } else {
          database.close();
        }
        expect(fs.readFileSync(f.journalPath)[18]).toBe(2);
        expect(fs.existsSync(`${f.journalPath}-wal`)).toBe(liveWriter);
        expect(fs.existsSync(`${f.journalPath}-shm`)).toBe(liveWriter);
        const before = journalFiles(f.anchor);
        await expect(status(f.anchor, f.operationId)).rejects.toThrow();
        expect(journalFiles(f.anchor)).toEqual(before);
        await expect(recovery(f.anchor, "repair", f.operationId)).rejects.toThrow();
        expect(journalFiles(f.anchor)).toEqual(before);
      } finally {
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("keeps all 64 bounded launcher entries while exact-revision intents advance", async () => {
    const launchers = Array.from({ length: 64 }, (_, index) => ({
      ...f.record.descriptor.launchers[0]!,
      name: `launcher-${index}`,
      previous: "p".repeat(4096),
      candidate: "c".repeat(4096),
    }));
    replaceField(
      f.journalPath,
      "descriptor_json",
      JSON.stringify({ ...f.record.descriptor, launchers }),
    );
    const record = openPackageActivationJournal(f.anchor).read();
    expect(record.descriptor.launchers).toEqual(launchers);
    expect(record).toMatchObject({ revision: f.record.revision, phase: "prepared", intent: null });
    const publishing = await f.transition(record, "publishing", { kind: "displace" });
    expect(publishing).toMatchObject({
      revision: f.record.revision + 1,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: record.descriptor,
    });
    await expect(f.transition(record, "publication-complete", null)).rejects.toThrow(
      "no longer current",
    );
    expect(f.journal.read()).toEqual(publishing);
    const disarmed = await f.transition(publishing, "rollback-in-progress", null);
    const restored = await f.transition(disarmed, "rolled-back", null);
    expect(openPackageActivationJournal(f.anchor).read()).toEqual(restored);
    expect(restored).toMatchObject({
      revision: f.record.revision + 3,
      phase: "rolled-back",
      descriptor: record.descriptor,
    });
    withDatabase(
      f.journalPath,
      (db) => {
        expect(db.prepare("SELECT COUNT(*) AS count FROM package_activation").get()).toEqual({
          count: 1,
        });
      },
      true,
    );
  });

  it.each([
    ["malformed descriptor", "descriptor_json", () => "{"],
    ["unknown phase", "phase", () => "automatically-repaired"],
    ["negative revision", "revision", () => -1],
    ["invalid intent", "intent_json", () => JSON.stringify({ kind: "displace", unexpected: true })],
    [
      "invalid publication identity",
      "publications_json",
      () => JSON.stringify([{ name: "openclaw", identity: "not-an-inode" }]),
    ],
    [
      "too many launchers",
      "descriptor_json",
      (record: PackageActivationRecord) =>
        JSON.stringify({
          ...record.descriptor,
          launchers: Array.from({ length: 65 }, (_, index) => ({
            name: `launcher-${index}`,
            previous: null,
            candidate: "candidate",
            previousIdentity: null,
            candidateIdentity: record.descriptor.launchers[0]!.candidateIdentity,
          })),
        }),
    ],
    [
      "duplicate launcher names",
      "descriptor_json",
      (record: PackageActivationRecord) =>
        JSON.stringify({
          ...record.descriptor,
          launchers: [record.descriptor.launchers[0], record.descriptor.launchers[0]],
        }),
    ],
    ["missing operation", null, () => "DELETE FROM package_activation"],
    [
      "additional operation",
      null,
      () =>
        "INSERT INTO package_activation SELECT 2, revision, phase, descriptor_json, intent_json, publications_json FROM package_activation WHERE slot = 1",
    ],
  ] as const)("preserves a journal with %s", async (name, column, value) => {
    if (column === null) {
      withDatabase(f.journalPath, (db) => db.exec(value()));
    } else {
      replaceField(f.journalPath, column, value(f.record));
    }
    const before = journalFiles(f.anchor);
    expect(() =>
      (column === null ? f.journal : openPackageActivationJournal(f.anchor)).read(),
    ).toThrow(name === "malformed descriptor" ? SyntaxError : undefined);
    await expect(f.transition(f.record, "publishing", { kind: "displace" })).rejects.toThrow();
    expect(journalFiles(f.anchor)).toEqual(before);
  });

  it.each(["rollback-in-progress", "retiring"] as const)(
    "refuses forward repair after %s is durable",
    async (phase) => {
      const disarmed = await f.transition(f.record, phase, null);
      const before = journalFiles(f.anchor);
      await expect(status(f.anchor, f.operationId)).resolves.toEqual({
        phase,
        operationId: disarmed.descriptor.operationId,
        installKey: f.packageRoot,
      });
      await expect(recovery(f.anchor, "repair", f.operationId)).rejects.toThrow(
        `Forward publication is disarmed (${phase})`,
      );
      expect(journalFiles(f.anchor)).toEqual(before);
      expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    },
  );

  it("observes a committed intent after its acknowledgement is lost", async () => {
    const failure = new Error("journal commit acknowledgement lost");
    let lost = false;
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, options) => {
        const db = openDatabase(location, options);
        if (db.location() === f.journalPath) {
          const exec = db.exec.bind(db);
          db.exec = (sql) => {
            exec(sql);
            if (!lost && sql === "COMMIT") {
              lost = true;
              throw failure;
            }
          };
        }
        return db;
      });
    try {
      await expect(f.transition(f.record, "publishing", { kind: "displace" })).rejects.toBe(
        failure,
      );
    } finally {
      spy.mockRestore();
    }
    expect(lost).toBe(true);
    const committed = openPackageActivationJournal(f.anchor).read();
    expect(committed).toMatchObject({
      revision: f.record.revision + 1,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: f.record.descriptor,
    });
    expect(() => f.journal.assertCurrent(f.record)).toThrow("no longer current");
    const disarmed = await f.transition(committed, "rollback-in-progress", null);
    expect(disarmed.revision).toBe(f.record.revision + 2);
    expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
    expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
  });

  it("preserves the current intent when its live executor refuses the write", async () => {
    const failure = new Error("executor authority revoked");
    const before = journalFiles(f.anchor);
    expect(() =>
      f.journal.transition(f.record, "publishing", { kind: "displace" }, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(f.journal.read()).toEqual(f.record);
    expect(journalFiles(f.anchor)).toEqual(before);
  });
  const jsonColumns = ["descriptor_json", "intent_json", "publications_json"] as const;
  it.each(jsonColumns)(
    "refuses oversized %s before decoding without modifying the original journal",
    async (column) => {
      replaceField(f.journalPath, "descriptor_json", "{");
      // Under one million characters, but over the one MiB byte bound.
      replaceField(f.journalPath, column, "é".repeat(512 * 1024 + 1));
      const before = journalFiles(f.anchor);
      const names = fs.readdirSync(f.anchor);
      expect(() => openPackageActivationJournal(f.anchor).read()).toThrow(
        "Package publication journal must contain one bounded operation.",
      );
      expect(journalFiles(f.anchor)).toEqual(before);
      expect(fs.readdirSync(f.anchor)).toEqual(names);
    },
  );
});
