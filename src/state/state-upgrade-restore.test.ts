import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { LEGACY_ROLLBACK_SOURCE } from "../update/legacy-rollback-source.js";
import { createTrialPending, resolvePrefix, writeTrial, type Trial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { ensureOpenClawAgentSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import type { DatabaseTarget } from "./state-upgrade-databases.js";
import { beginStateUpgradeRestore, publishStateUpgradeRestore } from "./state-upgrade-restore.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
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
  {
    using db = new DatabaseSync(file);
    db.exec("CREATE TABLE witness (value TEXT)");
    db.exec("INSERT INTO witness VALUES ('original')");
  }
  const manifest = path.join(resolvePrefix(env), "releases", "candidate-release", ".restore");
  const generation = resolveRuntimeServiceBuildId() ?? VERSION;
  const image = `${file}.pre-${generation}`;
  const targets: DatabaseTarget[] = [
    { kind: "state", path: file, version: 41, minReader: 41, engine: "sqlite" },
  ];
  const capture = { targets, config: {} };
  return { root, env, trial, file, manifest, image, generation, capture };
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
    const restore = await beginStateUpgradeRestore(f.env);
    expect(restore).toBeUndefined();
    await publishStateUpgradeRestore(restore, f.capture);
    expect(fs.existsSync(f.manifest)).toBe(false);
    expect(fs.existsSync(f.image)).toBe(false);
    expect(value(f.file)).toBe("original");
  },
);

it("captures old-Gateway writes on a new release retry without resetting an older receipt", async () => {
  const f = await fixture();
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture);
  const older = fs.readFileSync(f.manifest, "utf8");
  runInNewContext(
    `${LEGACY_ROLLBACK_SOURCE}\nrestoreState(collectPreserved(stateDir,suffix,0,4,[]),suffix);`,
    { fs, path, stateDir: f.root, suffix: `.pre-${f.generation}` },
  );
  {
    using live = new DatabaseSync(f.file);
    live.exec("UPDATE witness SET value = 'old-gateway-write'");
  }
  await writeTrial({ ...f.trial, phase: "rolled-back" }, resolvePrefix(f.env));
  const following = await prepareNextTrial(f, "retry-run", f.trial.previous);
  const restore = await beginStateUpgradeRestore(f.env);
  expect(restore?.existing).toBeUndefined();
  await publishStateUpgradeRestore(restore, f.capture);
  expect(value(f.image)).toBe("old-gateway-write");
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
  const inode = fs.statSync(f.file).ino;
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture);
  expect(fs.statSync(f.file).ino).toBe(inode);
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

it("reuses immutable originals after live writes and preserves the frozen legacy rollback", async () => {
  const f = await fixture();
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture);
  const original = fs.statSync(f.image);
  const encoded = fs.readFileSync(f.manifest, "utf8");
  {
    using live = new DatabaseSync(f.file);
    live.exec("UPDATE witness SET value = 'candidate'");
  }
  expect(value(f.file)).toBe("candidate");
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture);
  expect(fs.statSync(f.image).ino).toBe(original.ino);
  expect(value(f.image)).toBe("original");
  expect(fs.readFileSync(f.manifest, "utf8")).toBe(encoded);
  const preserved = runInNewContext(
    `${LEGACY_ROLLBACK_SOURCE}\nconst files=collectPreserved(stateDir,suffix,0,4,[]); restoreState(files,suffix); files;`,
    { fs, path, stateDir: f.root, suffix: `.pre-${f.generation}` },
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
  expect(fs.existsSync(f.image)).toBe(false);
  expect(fs.readFileSync(f.manifest, "utf8")).toBe(encoded);
});

it.each(["missing-image", "malformed", "version", "coverage"] as const)(
  "refuses %s recovery evidence without changing live rows",
  async (mode) => {
    const f = await fixture();
    if (mode === "missing-image") {
      await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture);
      fs.rmSync(f.image);
      await expect(
        publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture),
      ).rejects.toThrow(/missing or invalid/);
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
        await expect(
          publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture),
        ).rejects.toThrow(/does not cover/);
      } else {
        await expect(beginStateUpgradeRestore(f.env)).rejects.toThrow(
          /Invalid update restore manifest/,
        );
      }
    }
    expect(value(f.file)).toBe("original");
  },
);

it("refuses a failed manifest publication without mutating live rows", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (destination === f.manifest) {
      throw Object.assign(new Error("synthetic manifest fsync/rename failure"), { code: "EIO" });
    }
    return rename(source, destination);
  });
  await expect(
    publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture),
  ).rejects.toThrow(/synthetic manifest/);
  expect(fs.existsSync(f.manifest)).toBe(false);
  expect(value(f.file)).toBe("original");
});

it("publishes an empty trial receipt once and preserves complete existing receipts on no-op starts", async () => {
  const f = await fixture();
  const empty = { targets: [], config: {} };
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), empty);
  const encoded = fs.readFileSync(f.manifest, "utf8");
  expect(JSON.parse(encoded)).toEqual({ v: 1, runId: "manifest-run", files: [] });
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), empty);
  expect(fs.readFileSync(f.manifest, "utf8")).toBe(encoded);
  expect(fs.existsSync(f.image)).toBe(false);

  await writeTrial({ ...f.trial, phase: "committed" }, resolvePrefix(f.env));
  const following = await prepareNextTrial(f, "next-run", f.trial.target);
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), f.capture);
  const complete = fs.readFileSync(following.manifest, "utf8");
  const image = fs.statSync(f.image);
  await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), empty);
  expect(fs.readFileSync(following.manifest, "utf8")).toBe(complete);
  expect(fs.statSync(f.image).ino).toBe(image.ino);
  expect(value(f.image)).toBe("original");
  expect(fs.readFileSync(f.manifest, "utf8")).toBe(encoded);
});

it("narrows unused legacy-import stores before runtime while preserving boot-created families", async () => {
  const f = await fixture();
  const agentPath = path.join(f.root, "agents", "new", "agent", "openclaw-agent.sqlite");
  const laterPath = path.join(f.root, "agents", "later", "agent", "openclaw-agent.sqlite");
  const target: DatabaseTarget = {
    kind: "agent",
    agentId: "new",
    path: agentPath,
    version: 0,
    minReader: 0,
    engine: "sqlite",
  };
  const complete = await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), {
    targets: [...f.capture.targets, target, { ...target, agentId: "later", path: laterPath }],
    config: {},
  });
  const manifest = JSON.parse(fs.readFileSync(f.manifest, "utf8")) as {
    files: Array<{ live: string; preimage: string | null }>;
  };
  const agentFiles = ["", "-wal", "-shm", "-journal", ".seal"].map(
    (suffix) => `${agentPath}${suffix}`,
  );
  expect(manifest.files.filter((entry) => entry.live.startsWith(agentPath))).toEqual(
    agentFiles.map((live) => ({ live, preimage: null })),
  );
  expect(fs.existsSync(agentPath)).toBe(false);
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  {
    using agent = new DatabaseSync(agentPath);
    ensureOpenClawAgentSchema(agent, "new", agentPath);
    expect(
      agent
        .prepare(
          "SELECT role, agent_id, schema_version FROM schema_meta WHERE meta_key = 'primary'",
        )
        .get(),
    ).toEqual({ role: "agent", agent_id: "new", schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    using live = new DatabaseSync(f.file);
    live.exec("UPDATE witness SET value = 'candidate'");
  }
  complete?.();
  const narrowed = JSON.parse(fs.readFileSync(f.manifest, "utf8")) as typeof manifest;
  expect(narrowed.files).not.toContainEqual({ live: laterPath, preimage: null });
  expect(narrowed.files).toContainEqual({ live: `${f.file}-wal`, preimage: null });
  fs.mkdirSync(path.dirname(laterPath), { recursive: true });
  {
    using later = new DatabaseSync(laterPath);
    ensureOpenClawAgentSchema(later, "later", laterPath);
    later.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('later-base')");
  }
  // A failed candidate can leave committed WAL companions for the old launcher to remove.
  const crashed = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE schema_meta SET app_version='candidate'");
    const later = new DatabaseSync(process.argv[2]);
    later.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO witness VALUES ('later-WAL')");
    process.kill(process.pid, "SIGKILL");
  `,
    agentPath,
    laterPath,
  ]);
  expect(crashed.error).toBeUndefined();
  expect(crashed.status, crashed.stderr?.toString()).not.toBe(0);
  expect(fs.statSync(`${agentPath}-wal`).size).toBeGreaterThan(0);
  expect(fs.statSync(`${laterPath}-wal`).size).toBeGreaterThan(0);
  runInNewContext(
    `${LEGACY_ROLLBACK_SOURCE}\nretirePlans(stateDir,generation); restoreState(collectPreserved(stateDir,suffix,0,4,[]),suffix);`,
    { fs, path, stateDir: f.root, generation: f.generation, suffix: `.pre-${f.generation}` },
  );
  for (const file of agentFiles) {
    expect(fs.existsSync(file)).toBe(false);
  }
  expect(value(f.file)).toBe("original");
  {
    using later = new DatabaseSync(laterPath, { readOnly: true });
    expect(later.prepare("SELECT value FROM witness ORDER BY rowid").all()).toEqual([
      { value: "later-base" },
      { value: "later-WAL" },
    ]);
  }
});

it("refreshes a narrowed prospective family on retry without re-imaging original rows", async () => {
  const f = await fixture();
  const added = path.join(f.root, "new.sqlite");
  const capture = {
    targets: [...f.capture.targets, { path: added, engine: "sqlite" as const }],
    config: {},
  };
  const complete = await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), capture);
  complete?.();
  expect(JSON.parse(fs.readFileSync(f.manifest, "utf8")).files).not.toContainEqual({
    live: added,
    preimage: null,
  });
  const inode = fs.statSync(f.image).ino;
  {
    using live = new DatabaseSync(f.file);
    live.exec("UPDATE witness SET value='candidate'");
  }
  const retry = await publishStateUpgradeRestore(await beginStateUpgradeRestore(f.env), capture);
  expect(JSON.parse(fs.readFileSync(f.manifest, "utf8")).files).toContainEqual({
    live: added,
    preimage: null,
  });
  {
    using created = new DatabaseSync(added);
    created.exec("CREATE TABLE witness(value TEXT)");
  }
  retry?.();
  expect(fs.statSync(f.image).ino).toBe(inode);
  expect(value(f.image)).toBe("original");
  expect(JSON.parse(fs.readFileSync(f.manifest, "utf8")).files).toContainEqual({
    live: added,
    preimage: null,
  });
});
