import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { ROLLBACK_SOURCE } from "../update/rollback-source.js";
import { createTrialPending, resolvePrefix, writeTrial, type Trial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import {
  beginStateUpgradeRestore,
  takeStateUpgradeRestoreCleanup,
  publishStateUpgradeRestore,
} from "./state-upgrade-restore.js";
import { applyPlan, type UpgradePlan } from "./state-upgrade-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  takeStateUpgradeRestoreCleanup();
  vi.restoreAllMocks();
});

async function fixture(phase: Trial["phase"] = "trial") {
  const root = dirs.make("state-restore-");
  const env = { OPENCLAW_STATE_DIR: root };
  const target = path.join("releases", "candidate-release", "openclaw");
  fs.mkdirSync(path.join(resolvePrefix(env), target), { recursive: true });
  const trial = await createTrialPending(
    {
      runId: "manifest-run",
      target,
      previous: root,
      version: VERSION,
      buildId: resolveRuntimeServiceBuildId() ?? undefined,
    },
    resolvePrefix(env),
  );
  await writeTrial({ ...trial, phase }, resolvePrefix(env));
  const file = path.join(root, "live.sqlite");
  const next = path.join(root, "next.sqlite");
  for (const [filename, initialValue] of [
    [file, "original"],
    [next, "candidate"],
  ] as const) {
    using db = new DatabaseSync(filename);
    db.exec("CREATE TABLE witness (value TEXT)");
    db.prepare("INSERT INTO witness VALUES (?)").run(initialValue);
  }
  const manifest = path.join(resolvePrefix(env), "releases", "candidate-release", ".restore");
  const image = `${file}.pre-restore-manifest-run`;
  const plan: UpgradePlan = {
    appVersion: "candidate-build",
    ops: [{ kind: "replace", live: file, next }],
  };
  return { root, env, trial, file, next, manifest, image, plan };
}

async function prepareNextTrial(
  f: Awaited<ReturnType<typeof fixture>>,
  runId: string,
  previous: string,
) {
  const target = path.join("releases", "next-release", "openclaw");
  fs.mkdirSync(path.join(resolvePrefix(f.env), target), { recursive: true });
  const pending = await createTrialPending(
    { runId, target, previous, version: VERSION },
    resolvePrefix(f.env),
  );
  await writeTrial({ ...pending, phase: "trial" }, resolvePrefix(f.env));
  return {
    trial: pending,
    manifest: path.join(resolvePrefix(f.env), "releases", "next-release", ".restore"),
  };
}

function value(file: string): string {
  // No companion file can supply a missing committed frame to this assertion.
  using db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  return String(db.prepare("SELECT value FROM witness").get()?.value);
}

it.each(["pending", "committed", "rolled-back"] as const)(
  "does not authorize restore writes from phase %s",
  async (phase) => {
    const f = await fixture(phase);
    expect(await beginStateUpgradeRestore(f.env)).toBeUndefined();
    expect(fs.existsSync(f.manifest)).toBe(false);
    expect(fs.existsSync(f.image)).toBe(false);
  },
);

it("isolates an old-preparer retry in its own prepared release without resetting older receipts", async () => {
  const f = await fixture();
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.plan);
  const older = fs.readFileSync(f.manifest, "utf8");
  await writeTrial({ ...f.trial, phase: "rolled-back" }, resolvePrefix(f.env));
  const following = await prepareNextTrial(f, "retry-run", f.trial.previous);
  const restore = await beginStateUpgradeRestore(f.env);
  expect(restore?.existing).toBeUndefined();
  expect(publishStateUpgradeRestore(restore, f.plan).files).toBe(1);
  expect(JSON.parse(fs.readFileSync(following.manifest, "utf8")).runId).toBe("retry-run");
  expect(fs.readFileSync(f.manifest, "utf8")).toBe(older);
});

it("folds a crashed writer's committed WAL into an independent single-file image", async () => {
  const f = await fixture();
  fs.rmSync(f.file);
  const crashed = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('committed-wal')");
    process.kill(process.pid, "SIGKILL");
  `,
    f.file,
  ]);
  expect(crashed.error).toBeUndefined();
  expect(crashed.status, crashed.stderr?.toString()).not.toBe(0);
  expect(fs.statSync(`${f.file}-wal`).size).toBeGreaterThan(0);
  f.plan.ops.push({ kind: "remove", live: `${f.file}-wal` });
  const inode = fs.statSync(f.file).ino;
  const restore = await beginStateUpgradeRestore(f.env);
  expect(publishStateUpgradeRestore(restore, f.plan)).toEqual({
    files: 1,
    symlinks: 0,
  });
  expect(fs.statSync(f.image).ino).not.toBe(inode);
  expect(value(f.image)).toBe("committed-wal");
  expect(JSON.parse(fs.readFileSync(f.manifest, "utf8"))).toEqual({
    v: 1,
    runId: "manifest-run",
    files: [
      { live: f.file, preimage: f.image },
      ...["-wal", "-shm", "-journal", ".seal"].map((suffix) => ({
        live: `${f.file}${suffix}`,
        preimage: null,
      })),
    ],
  });
  expect(fs.existsSync(`${f.file}-wal`)).toBe(false);
});

it("reuses immutable originals and lets the previous Gateway open the legacy rollback", async () => {
  const f = await fixture();
  const restore = await beginStateUpgradeRestore(f.env);
  publishStateUpgradeRestore(restore, f.plan);
  const original = fs.statSync(f.image);
  applyPlan(f.plan);
  expect(value(f.file)).toBe("candidate");
  const resumed = await beginStateUpgradeRestore(f.env);
  publishStateUpgradeRestore(resumed, f.plan, true);
  expect(fs.statSync(f.image).ino).toBe(original.ino);
  expect(value(f.image)).toBe("original");
  const suffix = ".pre-candidate-build";
  const preserved = runInNewContext(
    `${ROLLBACK_SOURCE}\nconst files=collectPreserved(stateDir,suffix,0,4,[]); restoreState(files,suffix); files;`,
    {
      fs,
      path,
      stateDir: f.root,
      suffix,
    },
  ) as string[];
  expect([...preserved]).toEqual([f.file]);
  const opened = openRootFileSync({
    absolutePath: f.file,
    rootPath: f.root,
    boundaryLabel: "client credential store",
    rejectSymlinks: true,
  });
  if (!opened.ok) {
    throw opened.error;
  }
  fs.closeSync(opened.fd);
  expect(value(f.file)).toBe("original");
  expect(fs.existsSync(f.image)).toBe(true);
  expect(fs.existsSync(f.manifest)).toBe(true);
});

it.each(["missing", "malformed", "version", "coverage"] as const)(
  "refuses %s recovery evidence before resuming a durable swap plan",
  async (mode) => {
    const f = await fixture();
    if (mode === "missing") {
      const restore = await beginStateUpgradeRestore(f.env);
      expect(() => publishStateUpgradeRestore(restore, f.plan, true)).toThrow(
        /no matching restore manifest/,
      );
    } else {
      fs.writeFileSync(
        f.manifest,
        mode === "malformed"
          ? "{"
          : JSON.stringify({
              v: mode === "version" ? 2 : 1,
              runId: "manifest-run",
              files: [],
            }),
      );
      if (mode === "coverage") {
        const restore = await beginStateUpgradeRestore(f.env);
        expect(() => publishStateUpgradeRestore(restore, f.plan, true)).toThrow(/does not cover/);
      } else {
        await expect(beginStateUpgradeRestore(f.env)).rejects.toThrow(
          /Invalid update restore manifest/,
        );
      }
    }
    expect(value(f.file)).toBe("original");
    expect(value(f.next)).toBe("candidate");
  },
);

it("removes unpublished images when manifest publication fails, without applying the plan", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (destination === f.manifest) {
      throw Object.assign(new Error("synthetic manifest fsync/rename failure"), { code: "EIO" });
    }
    return rename(source, destination);
  });
  const restore = await beginStateUpgradeRestore(f.env);
  expect(() => publishStateUpgradeRestore(restore, f.plan)).toThrow(/synthetic manifest/);
  expect(fs.existsSync(f.manifest)).toBe(false);
  expect(fs.existsSync(f.image)).toBe(false);
  expect(value(f.file)).toBe("original");
});

it("leaves the original and no partial image when the recovery copy runs out of space", async () => {
  const f = await fixture();
  vi.spyOn(fs, "copyFileSync").mockImplementationOnce((_source, destination) => {
    fs.writeFileSync(destination, "partial image");
    throw Object.assign(new Error("synthetic full filesystem"), { code: "ENOSPC" });
  });
  const restore = await beginStateUpgradeRestore(f.env);
  expect(() => publishStateUpgradeRestore(restore, f.plan)).toThrow(/synthetic full filesystem/);
  expect(fs.existsSync(f.manifest)).toBe(false);
  expect(fs.existsSync(f.image)).toBe(false);
  expect(fs.existsSync(`${f.image}.tmp`)).toBe(false);
  expect(value(f.file)).toBe("original");
});

it("declares removal of a newly created SQLite file and every possible companion", async () => {
  const f = await fixture();
  const live = path.join(f.root, "new.sqlite");
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), {
    ops: [{ kind: "add", live, next: f.next }],
  });
  expect(JSON.parse(fs.readFileSync(f.manifest, "utf8")).files).toEqual(
    ["", "-wal", "-shm", "-journal", ".seal"].map((suffix) => ({
      live: `${live}${suffix}`,
      preimage: null,
    })),
  );
  expect(fs.existsSync(live)).toBe(false);
});

it("keeps an unremovable old image advisory for the next no-upgrade trial", async () => {
  const f = await fixture();
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.plan);
  fs.rmSync(f.image);
  fs.mkdirSync(f.image);
  await writeTrial({ ...f.trial, phase: "committed" }, resolvePrefix(f.env));
  const cleanup = takeStateUpgradeRestoreCleanup();
  expect(cleanup?.()).toEqual([expect.stringContaining("Run openclaw triage")]);
  const following = await prepareNextTrial(f, "after-warning", f.trial.target);
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), { ops: [] });
  expect(JSON.parse(fs.readFileSync(following.manifest, "utf8"))).toEqual({
    v: 1,
    runId: "after-warning",
    files: [],
  });
  expect(fs.statSync(f.image).isDirectory()).toBe(true);
  expect(value(f.file)).toBe("original");
});

it("preserves leaf symlinks and external config without following their targets", async () => {
  const f = await fixture();
  const external = dirs.make("state-restore-config-");
  const config = path.join(external, "openclaw.json");
  fs.writeFileSync(config, "original config", { mode: 0o640 });
  const link = path.join(f.root, "config-link");
  fs.symlinkSync("missing-config-target", link, "file");
  const restore = await beginStateUpgradeRestore(f.env);
  const plan = {
    ops: [
      { kind: "remove" as const, live: config },
      { kind: "remove" as const, live: link },
    ],
  };
  expect(publishStateUpgradeRestore(restore, plan)).toEqual({ files: 1, symlinks: 1 });
  expect(fs.readFileSync(`${config}.pre-restore-manifest-run`, "utf8")).toBe("original config");
  expect(fs.statSync(`${config}.pre-restore-manifest-run`).mode).toBe(fs.statSync(config).mode);
  expect(fs.readlinkSync(`${link}.pre-restore-manifest-run`)).toBe("missing-config-target");
});

it("lets delayed cleanup retire only its captured images after another release publishes", async () => {
  const f = await fixture();
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.plan);
  await writeTrial({ ...f.trial, phase: "committed" }, resolvePrefix(f.env));
  const cleanupA = takeStateUpgradeRestoreCleanup();
  const following = await prepareNextTrial(f, "next-run", f.trial.target);
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.plan);
  const cleanupB = takeStateUpgradeRestoreCleanup();
  const nextImage = `${f.file}.pre-restore-next-run`;
  // Release GC may already have removed A's receipt. Its process still owns the
  // captured list, not whichever manifest happens to exist when IPC completes.
  fs.rmSync(f.manifest);
  expect(cleanupA?.()).toEqual([]);
  expect(fs.existsSync(f.image)).toBe(false);
  expect(fs.existsSync(nextImage)).toBe(true);
  await writeTrial({ ...following.trial, phase: "committed" }, resolvePrefix(f.env));
  expect(cleanupB?.()).toEqual([]);
  expect(fs.existsSync(nextImage)).toBe(false);
  expect(JSON.parse(fs.readFileSync(following.manifest, "utf8")).runId).toBe("next-run");
  expect(value(f.file)).toBe("original");
});
