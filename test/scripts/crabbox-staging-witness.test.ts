import { execFileSync, type SpawnSyncOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySourceWitness, type FrozenSource } from "../../scripts/crabbox-staging-witness.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const fsck = vi.hoisted(() => ({
  older: false,
  timeOut: false,
  budgets: [] as Array<number | undefined>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: (command: string, args: readonly string[], options: SpawnSyncOptions) => {
      const version = args.includes("version");
      if (fsck.older && (version || args.includes("--no-references"))) {
        return {
          status: version ? 0 : 129,
          stdout: Buffer.from(version ? "git version 2.49.0\n" : ""),
        };
      }
      if (!args.includes("fsck")) {
        return original.spawnSync(command, args, options);
      }
      fsck.budgets.push(options.timeout);
      if (fsck.timeOut) {
        return {
          error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
        };
      }
      return original.spawnSync(command, args, options);
    },
  };
});

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  fsck.timeOut = false;
  fsck.older = false;
  fsck.budgets.length = 0;
});

function fixture(bytes = 0) {
  const root = temporary.make("openclaw-staging-witness-");
  const repository = join(root, "witness");
  const payloadRoot = join(root, "payload");
  for (const directory of [repository, payloadRoot]) {
    mkdirSync(directory);
  }
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  delete env.GIT_CONFIG_PARAMETERS;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main", "--template=");
  writeFileSync(join(repository, "history.txt"), "retained history only\n");
  git("add", "history.txt");
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
  if (bytes) {
    // Sparse sizing exercises the large-store budget without allocating 4 GiB.
    const sizing = join(repository, ".git/objects/info/sizing");
    writeFileSync(sizing, "");
    truncateSync(sizing, bytes);
  }
  const witness = {
    gitDir: realpathSync(join(repository, ".git")),
    ref: "refs/heads/main",
    commit: git("rev-parse", "HEAD"),
  };
  const metadataPaths = ["refs/.DS_Store", "refs/heads/.DS_Store"].map((path) =>
    join(witness.gitDir, path),
  );
  const addFinderMetadata = () => {
    for (const path of metadataPaths) {
      writeFileSync(path, Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
    }
  };
  return {
    git,
    historyBlob,
    metadataPaths,
    addFinderMetadata,
    params: { source, witness, payloadRoot },
    async verify() {
      const result = await verifySourceWitness({ source, witness, payloadRoot });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) {
        throw new Error("fixture witness must verify");
      }
      if (bytes) {
        expect(fsck.budgets[0]).toBeGreaterThan(200_000);
      }
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
      expect(() => result.revalidate()).not.toThrow();
    },
  };
}

describe.skipIf(process.platform === "win32")("Crabbox staging witness object proof", () => {
  it.each([
    ["native", 4 * 1024 ** 3],
    ["older", 0],
  ] as const)(
    "verifies %s Git references with %i extra bytes and refreshes the budget",
    async (git, bytes) => {
      const f = fixture(bytes);
      if (git === "native") {
        f.addFinderMetadata();
        await f.verify();
        expect(f.metadataPaths.map((path) => existsSync(path))).toEqual([true, true]);
        return;
      }
      const version = /^git version (\d+)\.(\d+)/u.exec(f.git("version"));
      fsck.older = true;

      await f.verify();
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
    },
  );

  it.each([
    ["missing history", "missing, corrupt, or unconnected objects"],
    ["timeout", "exceeded its work budget"],
  ] as const)("classifies %s without permitting disposal", async (failure, reason) => {
    const f = fixture();
    if (failure === "timeout") {
      fsck.timeOut = true;
    } else {
      unlinkSync(
        join(f.params.witness.gitDir, "objects", f.historyBlob.slice(0, 2), f.historyBlob.slice(2)),
      );
    }
    const result = await verifySourceWitness(f.params);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    if (failure === "timeout" && !result.ok) {
      expect(result.reason).not.toContain("fsck");
    }
  });
});
