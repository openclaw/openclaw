import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  sealImmutableGeneration,
  verifyImmutableGeneration,
} from "./update-immutable-generation.js";
import type { CommandRunner } from "./update-runner-types.js";

async function unseal(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) {
    return;
  }
  await fs.chmod(root, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(root)) {
      await unseal(path.join(root, name));
    }
  }
}

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of temporary.dirs) {
      await unseal(directory);
    }
    cleanup();
  }),
);
let foreignPath: string | undefined;
beforeEach(() => {
  foreignPath = undefined;
  const lstat = fs.lstat;
  // Synthetic releases exercise real permissions and Git without requiring the test worker to be root.
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    const owner = String(args[0]) === foreignPath ? 1 : 0;
    stat.uid = typeof stat.uid === "bigint" ? BigInt(owner) : owner;
    return stat;
  });
});

const runGit: CommandRunner = async (argv, options) => {
  const command = argv[0];
  if (!command) {
    throw new Error("Generation verification requires a command.");
  }
  return {
    code: 0,
    stdout: execFileSync(command, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
    }),
    stderr: "",
  };
};

async function generation() {
  const root = temporary.make("openclaw-immutable-generation-");
  await fs.mkdir(path.join(root, "dist", "plugin-sdk"), { recursive: true });
  await fs.mkdir(path.join(root, "dist", "control-ui"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "dist/\n");
  await fs.writeFile(path.join(root, "source.txt"), "source\n");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "1.0.0",
      exports: { "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" } },
    }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const sha = git("rev-parse", "HEAD");
  for (const name of ["entry.js", "index.js", "plugin-sdk/core.js"]) {
    await fs.writeFile(path.join(root, "dist", name), "export {};\n");
  }
  await fs.writeFile(path.join(root, "dist", "control-ui", "index.html"), "ready");
  await fs.writeFile(
    path.join(root, "dist", "build-info.json"),
    JSON.stringify({ commit: sha, buildId: sha }),
  );
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    await fs.writeFile(path.join(root, "dist", name), JSON.stringify({ head: sha }));
  }
  return { root, sha };
}

describe("sealed immutable generation", () => {
  it("checks the selected generation even when the caller supplies another Git repository", async () => {
    const { root, sha } = await generation();
    const foreign = temporary.make("openclaw-immutable-foreign-git-");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, foreign]);
    await fs.writeFile(path.join(root, "source.txt"), "uncommitted candidate source\n");
    await sealImmutableGeneration(root);
    vi.stubEnv("GIT_DIR", path.join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    try {
      await expect(verifyImmutableGeneration(root, sha, runGit)).rejects.toThrow(
        "uncommitted source changes",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("seals code and dependencies while preserving executable bits and contained links, and verifies without writing Git metadata", async () => {
    const { root, sha } = await generation();
    const executable = path.join(root, "dist", "index.js");
    await fs.chmod(executable, 0o755);
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\nnode_modules/\n");
    await fs.symlink("../dist/index.js", path.join(root, "node_modules", "contained"));
    const index = path.join(root, ".git", "index");
    const beforeIndex = await fs.readFile(index);
    await sealImmutableGeneration(root);
    const beforeMtime = (await fs.stat(index)).mtimeMs;
    const result = await verifyImmutableGeneration(root, sha, runGit);
    expect(result.buildDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.identity).toMatch(/^\d+:\d+$/u);
    expect((await fs.stat(executable)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(root, "source.txt"))).mode & 0o777).toBe(0o444);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o555);
    expect(await fs.readFile(index)).toEqual(beforeIndex);
    expect((await fs.stat(index)).mtimeMs).toBe(beforeMtime);
  });

  it.each([
    ["different HEAD", /HEAD does not match/u],
    ["dirty source", /uncommitted source/u],
    ["stale build", /git runtime mismatch/u],
    ["missing SDK", /ENOENT/u],
  ] as const)("refuses a sealed release with %s", async (kind, error) => {
    const { root, sha } = await generation();
    if (kind === "dirty source") {
      await fs.writeFile(path.join(root, "source.txt"), "edited\n");
    } else if (kind === "stale build") {
      await fs.writeFile(
        path.join(root, "dist", "build-info.json"),
        JSON.stringify({ commit: "0".repeat(40) }),
      );
    } else if (kind === "missing SDK") {
      await fs.unlink(path.join(root, "dist", "plugin-sdk", "core.js"));
    }
    await sealImmutableGeneration(root);
    await expect(
      verifyImmutableGeneration(root, kind === "different HEAD" ? "0".repeat(40) : sha, runGit),
    ).rejects.toThrow(error);
  });

  it.each(["escaping symlink", "foreign owner", "shared hardlink"] as const)(
    "refuses %s before changing any permissions",
    async (kind) => {
      const { root } = await generation();
      const source = path.join(root, "source.txt");
      const before = (await fs.stat(source)).mode;
      if (kind === "escaping symlink") {
        await fs.symlink(path.dirname(root), path.join(root, "outside"));
      } else if (kind === "foreign owner") {
        foreignPath = source;
      } else {
        await fs.link(source, path.join(root, "shared"));
      }
      await expect(sealImmutableGeneration(root)).rejects.toThrow(/escapes|root-owned|hardlinked/u);
      expect((await fs.stat(source)).mode).toBe(before);
    },
  );

  it("rejects a generation made writable after sealing", async () => {
    const { root, sha } = await generation();
    await sealImmutableGeneration(root);
    await fs.chmod(path.join(root, "dist", "plugin-sdk", "core.js"), 0o644);
    await expect(verifyImmutableGeneration(root, sha, runGit)).rejects.toThrow("not sealed");
  });
});
