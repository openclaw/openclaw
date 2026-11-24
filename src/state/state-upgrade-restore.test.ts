import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ROLLBACK_SOURCE } from "../update/rollback-source.js";
import { createTrialPending, resolvePrefix, writeTrial, type Trial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import {
  beginStateUpgradeRestore,
  cleanupStateUpgradeRestore,
  publishStateUpgradeRestore,
} from "./state-upgrade-restore.js";
import { applyPlan, type UpgradePlan } from "./state-upgrade-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(phase: Trial["phase"] = "trial") {
  const root = dirs.make("state-restore-");
  const env = { OPENCLAW_STATE_DIR: root };
  const trial = await createTrialPending(
    {
      runId: "manifest-run",
      target: root,
      previous: root,
      version: VERSION,
      buildId: resolveRuntimeServiceBuildId() ?? undefined,
    },
    resolvePrefix(env),
  );
  await writeTrial({ ...trial, phase }, resolvePrefix(env));
  const file = path.join(root, "live.sqlite");
  const next = path.join(root, "next.sqlite");
  for (const [filename, value] of [
    [file, "original"],
    [next, "candidate"],
  ] as const) {
    using db = new DatabaseSync(filename);
    db.exec("CREATE TABLE witness (value TEXT)");
    db.prepare("INSERT INTO witness VALUES (?)").run(value);
  }
  const manifest = path.join(root, "git-install", "releases", ".restore");
  const image = `${file}.pre-restore-manifest-run`;
  const plan: UpgradePlan = {
    appVersion: "candidate-build",
    ops: [{ kind: "replace", live: file, next }],
  };
  return { root, env, trial, file, next, manifest, image, plan };
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

it("binds restore authority to this candidate's build", async () => {
  const f = await fixture();
  await writeTrial({ ...f.trial, phase: "trial", buildId: "another-build" }, resolvePrefix(f.env));
  expect(await beginStateUpgradeRestore(f.env)).toBeUndefined();
  expect(fs.existsSync(f.manifest)).toBe(false);
});

it("folds a crashed writer's committed WAL into a hard-linked single-file image", async () => {
  const f = await fixture();
  fs.rmSync(f.file);
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('committed-wal')");
    process.exit(0);
  `,
    f.file,
  ]);
  expect(fs.statSync(`${f.file}-wal`).size).toBeGreaterThan(0);
  f.plan.ops.push({ kind: "remove", live: `${f.file}-wal` });
  const inode = fs.statSync(f.file).ino;
  const restore = await beginStateUpgradeRestore(f.env);
  expect(publishStateUpgradeRestore(restore, f.plan)).toEqual({
    linked: 1,
    copied: [],
    symlinks: 0,
  });
  expect(fs.statSync(f.image).ino).toBe(inode);
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

it("reuses immutable originals after a partial rename and preserves legacy rollback", async () => {
  const f = await fixture();
  const restore = await beginStateUpgradeRestore(f.env);
  publishStateUpgradeRestore(restore, f.plan);
  const original = fs.statSync(f.image);
  applyPlan(f.plan);
  expect(value(f.file)).toBe("candidate");
  const resumed = await beginStateUpgradeRestore(f.env);
  expect(publishStateUpgradeRestore(resumed, f.plan, true)).toEqual({
    linked: 0,
    copied: [],
    symlinks: 0,
  });
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

it("uses a byte copy only when the filesystem refuses a hard link", async () => {
  const f = await fixture();
  vi.spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("synthetic cross-device link"), { code: "EXDEV" });
  });
  const restore = await beginStateUpgradeRestore(f.env);
  expect(publishStateUpgradeRestore(restore, f.plan)).toEqual({
    linked: 0,
    copied: [`${f.file} (EXDEV)`],
    symlinks: 0,
  });
  expect(fs.statSync(f.image).ino).not.toBe(fs.statSync(f.file).ino);
  expect(value(f.image)).toBe("original");
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

it("reports cleanup failure without recursively removing an unexpected directory", async () => {
  const f = await fixture();
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.plan);
  fs.rmSync(f.image);
  fs.mkdirSync(f.image);
  await writeTrial({ ...f.trial, phase: "committed" }, resolvePrefix(f.env));
  const warnings = cleanupStateUpgradeRestore("manifest-run", f.env);
  expect(warnings).toEqual([expect.stringContaining("Run openclaw triage")]);
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
  expect(publishStateUpgradeRestore(restore, plan)).toEqual({ linked: 1, copied: [], symlinks: 1 });
  expect(fs.readFileSync(`${config}.pre-restore-manifest-run`, "utf8")).toBe("original config");
  expect(fs.statSync(`${config}.pre-restore-manifest-run`).mode).toBe(fs.statSync(config).mode);
  expect(fs.readlinkSync(`${link}.pre-restore-manifest-run`)).toBe("missing-config-target");
});

it("cleans stale images before new preparation and never lets old committed cleanup delete a newer run", async () => {
  const f = await fixture();
  publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.plan);
  await writeTrial({ ...f.trial, runId: "next-run", phase: "trial" }, resolvePrefix(f.env));
  const next = await beginStateUpgradeRestore(f.env);
  expect(fs.existsSync(f.image)).toBe(false);
  publishStateUpgradeRestore(next, f.plan);
  const nextImage = `${f.file}.pre-restore-next-run`;
  expect(cleanupStateUpgradeRestore("manifest-run", f.env)).toEqual([]);
  expect(fs.existsSync(nextImage)).toBe(true);
  await writeTrial({ ...f.trial, runId: "next-run", phase: "committed" }, resolvePrefix(f.env));
  expect(cleanupStateUpgradeRestore("next-run", f.env)).toEqual([]);
  expect(fs.existsSync(nextImage)).toBe(false);
  expect(JSON.parse(fs.readFileSync(f.manifest, "utf8")).runId).toBe("next-run");
  expect(value(f.file)).toBe("original");
});
