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
    vi.unstubAllEnvs();
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
  const json = (file: string, value: unknown) =>
    fs.writeFile(path.join(root, file), JSON.stringify(value));
  await fs.mkdir(path.join(root, "dist/plugin-sdk"), { recursive: true });
  await fs.mkdir(path.join(root, "dist/control-ui"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "dist/\n");
  await fs.writeFile(path.join(root, "source.txt"), "source\n");
  await json("package.json", {
    name: "openclaw",
    version: "1.0.0",
    exports: {
      "./plugin-sdk/core": {
        types: "./dist/plugin-sdk/core.d.ts",
        default: "./dist/plugin-sdk/core.js",
      },
    },
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    ..."-c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture".split(" "),
  );
  const sha = git("rev-parse", "HEAD");
  for (const name of ["entry.js", "index.js", "plugin-sdk/core.js", "plugin-sdk/core.d.ts"]) {
    await fs.writeFile(path.join(root, "dist", name), "export {};\n");
  }
  await fs.writeFile(path.join(root, "dist/control-ui/index.html"), "ready");
  await json("dist/build-info.json", { commit: sha, buildId: sha });
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    await json(`dist/${name}`, { head: sha });
  }
  return { root, sha, json };
}

describe("sealed immutable generation", () => {
  it.each(["config", "commondir"])(
    "refuses build-authored Git helpers through %s before privileged Git verification",
    async (kind) => {
      const { root, sha } = await generation();
      const metadata = kind === "config" ? path.join(root, ".git") : path.join(root, "shared-git");
      if (kind === "commondir") {
        await fs.cp(path.join(root, ".git"), metadata, { recursive: true });
        await fs.writeFile(path.join(root, ".git/commondir"), "../shared-git\n");
      }
      await fs.appendFile(path.join(metadata, "config"), '\n[filter "candidate"]\n\tclean = cat\n');
      await fs.writeFile(path.join(metadata, "info/attributes"), "source.txt filter=candidate\n");
      await sealImmutableGeneration(root);
      const command = vi.fn(runGit);
      await expect(verifyImmutableGeneration(root, sha, command)).rejects.toThrow(
        kind === "config" ? "unsupported Git configuration" : "independent Git metadata",
      );
      expect(command).not.toHaveBeenCalled();
    },
  );

  it("seals code and dependencies while preserving executable bits and contained links, and verifies without writing Git metadata", async () => {
    const { root, sha } = await generation();
    const executable = path.join(root, "dist/index.js");
    await fs.chmod(executable, 0o755);
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.appendFile(path.join(root, ".git/info/exclude"), "\nnode_modules/\n");
    await fs.symlink("../dist/index.js", path.join(root, "node_modules/contained"));
    const index = path.join(root, ".git/index");
    const beforeIndex = await fs.readFile(index);
    await sealImmutableGeneration(root);
    const beforeMtime = (await fs.stat(index)).mtimeMs;
    const result = await verifyImmutableGeneration(root, sha, runGit);
    expect(result).toMatchObject({
      buildDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      identity: expect.stringMatching(/^\d+:\d+$/u),
    });
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
    ["missing SDK declarations", /core\.d\.ts/u],
    ["foreign Git context", "uncommitted source changes"],
    ["writable after sealing", "not sealed"],
  ] as const)("refuses a sealed release with %s", async (kind, error) => {
    const { root, sha, json } = await generation();
    if (kind === "foreign Git context") {
      const foreign = temporary.make("openclaw-immutable-foreign-git-");
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, foreign]);
      vi.stubEnv("GIT_DIR", path.join(foreign, ".git"));
      vi.stubEnv("GIT_WORK_TREE", foreign);
    }
    if (kind === "dirty source" || kind === "foreign Git context") {
      await fs.writeFile(path.join(root, "source.txt"), "edited\n");
    } else if (kind === "stale build") {
      await json("dist/build-info.json", { commit: "0".repeat(40) });
    } else if (kind === "missing SDK declarations") {
      await fs.unlink(path.join(root, "dist", "plugin-sdk", "core.d.ts"));
    }
    await sealImmutableGeneration(root);
    if (kind === "writable after sealing") {
      await fs.chmod(path.join(root, "dist/plugin-sdk/core.js"), 0o644);
    }
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
});
