import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { selectChannelTag } from "./update-runner-git-target.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner } from "./update-runner-types.js";

const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_COUNT: "0",
  LC_ALL: "C",
};

const extendedOnly = ["v2026.9.33", "v2026.9.34", "v2026.9.34-1"];
it.each([
  ["stable", extendedOnly, null],
  ["beta", extendedOnly, null],
  ["beta", ["v2026.9.34", "v2026.9.33-beta.1", "v2026.9.32"], "v2026.9.33-beta.1"],
] as const)("selects %s release tag from %j as %s", (channel, tags, expected) => {
  expect(selectChannelTag(tags, channel)).toBe(expected);
});

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...gitEnv },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const forbidden = (operation: string) => async () => {
  throw new Error(`A refused fetch or current release must not ${operation}`);
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(releaseRemote = "upstream", forkRemote?: string) {
  const directory = tempDirs.make("openclaw-update-tags-");
  const upstream = path.join(directory, "upstream.git");
  const seed = path.join(directory, "seed");
  const root = path.join(directory, "installed");
  const write = (base: string, file: string, contents: unknown) =>
    writeFileSync(
      path.join(base, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  git(directory, "init", "--bare", "--initial-branch=main", upstream);
  git(directory, "clone", upstream, seed);
  git(seed, "config", "user.name", "OpenClaw Test");
  git(seed, "config", "user.email", "openclaw@example.invalid");
  write(seed, "package.json", { name: "openclaw", version: "2026.9.1" });
  write(seed, ".gitignore", "dist/\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "original release");
  const oldTag = git(seed, "rev-parse", "HEAD");
  git(seed, "tag", "v2026.9.1");
  git(seed, "commit", "--allow-empty", "-m", "installed commit");
  const release = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "main", "--tags");
  git(directory, "clone", "--origin", releaseRemote, upstream, root);
  git(root, "checkout", "--detach");
  const dist = path.join(root, "dist");
  mkdirSync(path.join(dist, "control-ui"), { recursive: true });
  write(dist, "entry.js", "export {};\n");
  write(dist, "build-info.json", { commit: release, buildId: release });
  for (const stamp of [".buildstamp", ".runtime-postbuildstamp"]) {
    write(dist, stamp, { head: release });
  }
  write(dist, "control-ui/index.html", "ready");
  git(root, "tag", "local-only", oldTag);
  if (forkRemote) {
    const fork = path.join(directory, "fork.git");
    git(directory, "clone", "--bare", upstream, fork);
    git(root, "remote", "add", forkRemote, fork);
  }
  // Advance main independently of the corrected, already-installed release.
  git(seed, "tag", "-f", "v2026.9.1");
  git(seed, "commit", "--allow-empty", "-m", "next development commit");
  const branch = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "main", "+refs/tags/v2026.9.1:refs/tags/v2026.9.1");
  return { root, seed, oldTag, release, branch, releaseRemote };
}

async function update(setup: ReturnType<typeof fixture>, channel: "stable" | "beta" = "stable") {
  const fetches: Array<
    { argv: string[]; code: number | null } & Record<"tag" | "local" | "branch", string>
  > = [];
  const runCommand: CommandRunner = async (argv, options) => {
    if (argv[0] !== "git") {
      throw new Error(`Unexpected build command: ${argv[0]}`);
    }
    const commandOptions = { ...options, env: { ...options.env, ...gitEnv } };
    const result = await runCommandWithTimeout(argv, commandOptions);
    const fetchIndex = argv.indexOf("fetch");
    if (fetchIndex !== -1) {
      const read = async (ref: string) => {
        const value = await runCommandWithTimeout(
          [...argv.slice(0, fetchIndex), "rev-parse", ref],
          commandOptions,
        );
        return value.code === 0 ? value.stdout.trim() : "";
      };
      fetches.push({
        argv: argv.slice(fetchIndex),
        code: result.code,
        tag: await read("refs/tags/v2026.9.1"),
        local: await read("refs/tags/local-only"),
        branch: await read(`refs/remotes/${setup.releaseRemote}/main`),
      });
    }
    return result;
  };
  const result = await updateGitCheckout({
    gitRoot: setup.root,
    runCommand,
    defaultCommandEnv: undefined,
    timeoutMs: 5000,
    startedAt: Date.now(),
    opts: {
      channel,
      inspectGitTarget: forbidden("enter candidate admission"),
      validateCandidate: forbidden("validate a candidate"),
      beforeGitMutation: forbidden("mutate the checkout"),
      runGitDoctor: forbidden("run Doctor"),
    },
  });
  return { result, fetches };
}

it.each([
  ["upstream", "origin", true, "stable"],
  ["origin", "fork", false, "stable"],
  ["upstream", undefined, false, "stable"],
  ["upstream", undefined, true, "beta"],
] as const)(
  "refreshes only %s tags with fork %s (tracked=%s, channel=%s)",
  async (releaseRemote, forkRemote, tracked, channel) => {
    const setup = fixture(releaseRemote, forkRemote);
    if (channel === "beta") {
      for (const tag of extendedOnly) {
        git(setup.seed, "tag", tag, setup.oldTag);
      }
      git(setup.seed, "push", "origin", "--tags");
    }
    if (!tracked) {
      git(setup.root, "config", "--unset", "branch.main.remote");
    }
    git(setup.root, "config", "fetch.prune", "true");
    git(setup.root, "config", "fetch.pruneTags", "true");
    const { result, fetches } = await update(setup, channel);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "skipped",
      reason: "already-current",
    });
    expect(fetches).toEqual([
      expect.objectContaining({ code: 0, tag: setup.oldTag, branch: setup.branch }),
      {
        code: 0,
        tag: setup.release,
        local: setup.oldTag,
        branch: setup.branch,
        argv: [
          "fetch",
          "--no-tags",
          "--no-prune",
          "--no-prune-tags",
          releaseRemote,
          "+refs/tags/*:refs/tags/*",
        ],
      },
    ]);
    expect(
      ["v2026.9.1", "local-only", "HEAD"].map((ref) => git(setup.root, "rev-parse", ref)),
    ).toEqual([setup.oldTag, setup.oldTag, setup.release]);
  },
);

it("rejects a non-fast-forward protected branch before forcing tags", async () => {
  const setup = fixture();
  git(setup.root, "branch", "protected", setup.release);
  git(setup.root, "config", "remote.upstream.fetch", "refs/heads/main:refs/heads/protected");
  git(setup.seed, "push", "--force", "origin", `${setup.oldTag}:refs/heads/main`);
  const { result, fetches } = await update(setup);
  expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
  expect(result.steps.find((step) => step.name.includes("fetch"))?.stderrTail).toContain(
    "non-fast-forward",
  );
  expect(fetches).toHaveLength(1);
  expect(fetches[0]?.tag).toBe(setup.oldTag);
  expect(git(setup.root, "rev-parse", "protected")).toBe(setup.release);
});

it("requires an explicit authority for ambiguous non-origin remotes", async () => {
  const setup = fixture("upstream", "fork");
  git(setup.root, "config", "--unset", "branch.main.remote");
  const { result, fetches } = await update(setup);
  expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
  expect(result.steps.at(-1)?.stderrTail).toContain("Set branch.main.remote");
  expect(fetches).toHaveLength(0);
  expect(git(setup.root, "rev-parse", "v2026.9.1")).toBe(setup.oldTag);
});
