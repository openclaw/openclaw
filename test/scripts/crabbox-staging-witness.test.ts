import { execFileSync, type SpawnSyncOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySourceWitness, type FrozenSource } from "../../scripts/crabbox-staging-witness.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const fsck = vi.hoisted(() => ({ timeOut: false, budgets: [] as Array<number | undefined> }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: (command: string, args: readonly string[], options: SpawnSyncOptions) => {
      if (!args.includes("fsck")) {
        return original.spawnSync(command, args, options);
      }
      fsck.budgets.push(options.timeout);
      if (fsck.timeOut) {
        return {
          pid: 0,
          output: [],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          status: null,
          signal: "SIGKILL",
          error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
        };
      }
      return original.spawnSync(command, args, options);
    },
  };
});

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  fsck.timeOut = false;
  fsck.budgets.length = 0;
});

function fixture() {
  const root = temporary.make("openclaw-staging-witness-");
  const repository = join(root, "witness");
  const payloadRoot = join(root, "payload");
  const home = join(root, "home");
  for (const directory of [repository, payloadRoot, home]) {
    mkdirSync(directory);
  }
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, "empty-global"),
    GIT_CONFIG_SYSTEM: join(home, "empty-system"),
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  delete env.GIT_CONFIG_PARAMETERS;
  writeFileSync(env.GIT_CONFIG_GLOBAL!, "");
  writeFileSync(env.GIT_CONFIG_SYSTEM!, "");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main", "--template=");
  writeFileSync(join(repository, "source.txt"), "old source\n");
  writeFileSync(join(repository, "history.txt"), "retained history only\n");
  git("add", "source.txt", "history.txt");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "retained history");
  const historyBlob = git("rev-parse", "HEAD:history.txt");
  writeFileSync(join(repository, "source.txt"), "witnessed source\n");
  unlinkSync(join(repository, "history.txt"));
  git("add", "source.txt", "history.txt");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "witnessed source");
  const source: FrozenSource = {
    files: [{ path: "source.txt", mode: "100644", blob: git("hash-object", "source.txt") }],
    deleted: ["history.txt"],
  };
  const witness = {
    gitDir: realpathSync(join(repository, ".git")),
    ref: "refs/heads/main",
    commit: git("rev-parse", "HEAD"),
  };
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) {
    vi.stubEnv(key, env[key]);
  }
  const metadataPaths = ["refs/.DS_Store", "refs/heads/.DS_Store"].map((path) =>
    join(witness.gitDir, path),
  );
  const addFinderMetadata = () => {
    for (const path of metadataPaths) {
      writeFileSync(path, Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
    }
  };
  return {
    root,
    git,
    historyBlob,
    metadataPaths,
    addFinderMetadata,
    params: { source, witness, payloadRoot },
  };
}

describe.skipIf(process.platform === "win32")("Crabbox staging witness object proof", () => {
  it("Finder metadata in the ref database does not block the object proof", async () => {
    const f = fixture();
    f.addFinderMetadata();

    expect(await verifySourceWitness(f.params)).toMatchObject({ ok: true });
    for (const path of f.metadataPaths) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("missing reachable history objects fail closed with the object reason", async () => {
    const f = fixture();
    unlinkSync(
      join(f.params.witness.gitDir, "objects", f.historyBlob.slice(0, 2), f.historyBlob.slice(2)),
    );

    expect(await verifySourceWitness(f.params)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing, corrupt, or unconnected objects"),
    });
  });

  it("older Git without --[no-]references keeps recovering", async () => {
    const f = fixture();
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const version = /^git version (\d+)\.(\d+)/u.exec(f.git("version"));
    const shimDir = join(f.root, "bin");
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    version) printf 'git version 2.49.0\\n'; exit 0 ;;
    --no-references) printf 'unknown option: no-references\\n' >&2; exit 129 ;;
  esac
done
exec '${realGit.replaceAll("'", "'\\''")}' "$@"
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", shimDir + delimiter + process.env.PATH);

    expect(await verifySourceWitness(f.params)).toMatchObject({ ok: true });
    if (
      version &&
      (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 50))
    ) {
      f.addFinderMetadata();
      expect(await verifySourceWitness(f.params)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("reference database has errors"),
      });
    }
  });

  it("a Git read cut off by the budget reports budget exhaustion, not missing objects", async () => {
    const f = fixture();
    fsck.timeOut = true;

    const result = await verifySourceWitness(f.params);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exceeded its work budget"),
    });
    if (!result.ok) {
      expect(result.reason).not.toContain("fsck");
    }
  });

  it("explicit recovery scales fsck time with object storage; automatic recovery keeps the base bound", async () => {
    const f = fixture();
    // A sparse file stands in for a 4 GiB object store without allocating disk.
    const sizing = join(f.params.witness.gitDir, "objects", "info", "sizing");
    mkdirSync(join(sizing, ".."), { recursive: true });
    writeFileSync(sizing, "");
    truncateSync(sizing, 4 * 1024 ** 3);

    expect(await verifySourceWitness(f.params)).toMatchObject({ ok: true });
    expect(await verifySourceWitness({ ...f.params, automatic: true })).toMatchObject({
      ok: true,
    });
    const [explicit, automatic] = fsck.budgets;
    expect(explicit).toBeGreaterThan(200_000);
    expect(automatic).toBeLessThanOrEqual(120_000);
  });
});
