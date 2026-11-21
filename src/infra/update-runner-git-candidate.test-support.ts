import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";
import { copyTreeCloseOnExec } from "../../test/helpers/close-on-exec-copy.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { writeFixtureTree } from "./fixture-tree.test-support.js";
import { updateGitRelease } from "./update-runner-git-release.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const { runCommandWithTimeout } = processExec;

export type GitUpdateFixture = Awaited<ReturnType<typeof createGitFixtureCheckout>> & {
  events: string[];
  runCommand: CommandRunner;
  advanceRemote: () => Promise<string>;
  writeRuntime: (root?: string, sha?: string, layout?: string) => Promise<void>;
  validateCandidate: (candidateRoot: string) => Promise<void>;
  update: (opts?: GitUpdateOptions) => Promise<UpdateRunResult>;
};
type GitUpdateOptions = Partial<UpdateRunnerOptions>;

export async function createGitUpdateFixture(
  directory: string,
  manifest: Record<string, unknown> = {},
): Promise<GitUpdateFixture> {
  const checkout = await createGitFixtureCheckout(directory, manifest);
  const events: string[] = [];
  const runCommand: CommandRunner = async (argv, options) => {
    if (argv[0] === "git") {
      return runCommandWithTimeout(argv, options);
    }
    if (argv[0] === process.execPath && argv.at(-1) === "--version") {
      const pkg = JSON.parse(await readText(path.join(options.cwd!, "package.json")));
      return { code: 0, stdout: `OpenClaw ${pkg.version}\n`, stderr: "" };
    }
    if (argv[0] !== "pnpm") {
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    }
    if (argv[1] === "build") {
      expect(options.cwd).not.toBe(fixture.root);
      await fixture.writeRuntime(
        options.cwd!,
        await runFixtureGit(options.cwd!, "rev-parse", "HEAD"),
      );
      fixture.events.push("build");
    }
    return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
  };
  const fixture: GitUpdateFixture = {
    ...checkout,
    events,
    runCommand,
    advanceRemote: () => advanceFixtureRemote(checkout.remote),
    writeRuntime(
      root = checkout.root,
      sha: string = fixture.beforeSha,
      layout = "node_modules/.pnpm",
    ): Promise<void> {
      return writeRuntime(root, sha, path.join(directory, "shared-store"), layout);
    },
    async validateCandidate(candidateRoot: string) {
      await expectHead(checkout.root, fixture.beforeSha);
      expect(candidateRoot).not.toBe(checkout.root);
      await expectRuntime(candidateRoot, await runFixtureGit(candidateRoot, "rev-parse", "HEAD"));
      fixture.events.push("validate");
    },
    update(opts: GitUpdateOptions = {}): Promise<UpdateRunResult> {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(directory, "state"));
      return updateGitRelease({
        gitRoot: checkout.root,
        runCommand: fixture.runCommand,
        defaultCommandEnv: undefined,
        timeoutMs: 5000,
        startedAt: Date.now(),
        opts: {
          channel: "dev",
          inspectGitTarget: async () => {},
          validateCandidate: fixture.validateCandidate,
          beforeGitMutation: async () => {},
          ...opts,
        },
      });
    },
  };
  await fixture.writeRuntime();
  return fixture;
}

export function isolateGitIdentity() {
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  for (const role of ["AUTHOR", "COMMITTER"]) {
    for (const field of ["NAME", "EMAIL"]) {
      vi.stubEnv(`GIT_${role}_${field}`, undefined);
    }
  }
}

export const readText = (file: string) => fs.readFile(file, "utf8");

export async function writeFixtureFiles(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(([file, contents]) => fs.writeFile(path.join(root, file), contents)),
  );
}

export async function expectFile(file: string, contents: string) {
  expect(await readText(file)).toBe(contents);
}

export async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

export function expectStep(steps: UpdateStepResult[], expected: Partial<UpdateStepResult>) {
  expect(steps).toContainEqual(expect.objectContaining(expected));
}

export async function expectHead(root: string, sha: string) {
  expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(sha);
}

export async function runFixtureGit(root: string, ...args: string[]) {
  const result = await processExec.runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (code=${result.code}, termination=${result.termination}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export async function writeGitFixtureManifest(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.9.1",
      packageManager: "pnpm@12.0.0",
      ...overrides,
    }),
  );
}

async function createGitFixtureCheckout(directory: string, manifest: Record<string, unknown> = {}) {
  // Keep fixture-local identity authoritative during candidate rebases.
  isolateGitIdentity();
  const seed = await getOrCreatePromise(gitFixtureSeeds, JSON.stringify(manifest), async () => {
    const seedDirectory = await fs.realpath(gitFixtureDirectories.make("openclaw-git-seed-"));
    return { directory: seedDirectory, ...(await createGitFixtureSeed(seedDirectory, manifest)) };
  });
  copyTreeCloseOnExec(seed.directory, directory);
  const root = path.join(directory, "checkout");
  const remote = path.join(directory, "remote");
  await runFixtureGit(root, "remote", "set-url", "origin", remote);
  return { root, remote, beforeSha: seed.beforeSha };
}

const gitFixtureDirectories = useAutoCleanupTempDirTracker(afterAll);
const gitFixtureSeeds = new Map<
  string,
  Promise<{ directory: string; root: string; remote: string; beforeSha: string }>
>();

async function createGitFixtureSeed(directory: string, manifest: Record<string, unknown>) {
  const root = path.join(directory, "checkout");
  const remote = path.join(directory, "remote");
  await fs.mkdir(remote);
  await runFixtureGit(remote, "init", "--initial-branch=main");
  await runFixtureGit(remote, "config", "user.name", "OpenClaw Test");
  await runFixtureGit(remote, "config", "user.email", "openclaw@example.com");
  await writeGitFixtureManifest(remote, manifest);
  await fs.mkdir(path.join(remote, "packages", "runtime"), { recursive: true });
  await writeFixtureFiles(remote, {
    "openclaw.mjs": "export {};\n",
    "packages/runtime/index.js": "module.exports = require('./node_modules/nested.cjs');",
    ".gitignore": "node_modules/\ndist/\ndist-runtime/\n.artifacts\n.pnpm\ncache/\n",
  });
  await runFixtureGit(remote, "add", ".");
  await runFixtureGit(remote, "commit", "-m", "base");
  const beforeSha = await runFixtureGit(remote, "rev-parse", "HEAD");
  await runFixtureGit(directory, "clone", "--quiet", remote, root);
  await runFixtureGit(root, "config", "user.name", "OpenClaw Test");
  await runFixtureGit(root, "config", "user.email", "openclaw@example.com");
  return { root, remote, beforeSha };
}

async function advanceFixtureRemote(remote: string) {
  await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
  await runFixtureGit(remote, "add", ".");
  await runFixtureGit(remote, "commit", "-m", "candidate");
  return runFixtureGit(remote, "rev-parse", "HEAD");
}

const runtimeImports = [
  "../dist-runtime/identity.cjs",
  "../packages/runtime/dist-runtime/identity.cjs",
  "../node_modules/identity.cjs",
  "workspace-runtime",
  "relative-workspace-runtime",
  "external-runtime",
  "absolute-external-runtime",
  "../packages/runtime/node_modules/external-runtime",
  "virtual-runtime",
];

export async function writeRuntime(directory: string, sha: string, store: string, layout: string) {
  const root = await fs.realpath(directory);
  const external = path.join(store, sha);
  const virtualStore =
    layout === "external"
      ? path.join(store, "virtual-store")
      : path.resolve(root, layout === "symlink" ? ".pnpm" : layout);
  if (layout === "symlink") {
    const linkedStore = path.join(store, "linked-store", sha);
    await fs.mkdir(linkedStore, { recursive: true });
    await fs.rm(virtualStore, { force: true });
    await fs.symlink(linkedStore, virtualStore, "junction");
  }
  const virtualPackage = path.join(virtualStore, sha, "node_modules", "virtual-runtime");
  const identity = `module.exports = ${JSON.stringify(sha)};`;
  await writeFixtureTree(root, {
    [path.relative(root, path.join(external, "package.json"))]: '{"type":"commonjs"}',
    [path.relative(root, path.join(external, "index.js"))]: identity,
    [path.relative(root, path.join(virtualPackage, "index.js"))]: identity,
    "node_modules/identity.cjs": identity,
    "packages/runtime/node_modules/nested.cjs": identity,
    "dist-runtime/identity.cjs": identity,
    "packages/runtime/dist-runtime/identity.cjs": identity,
  });
  const workspace = path.join(root, "packages/runtime");
  for (const [relative, target, absolute] of [
    ["node_modules/workspace-runtime", workspace, true],
    ["node_modules/relative-workspace-runtime", workspace, false],
    ["node_modules/external-runtime", external, false],
    ["node_modules/absolute-external-runtime", external, true],
    ["packages/runtime/node_modules/external-runtime", external, false],
    ["node_modules/virtual-runtime", virtualPackage, false],
  ] as const) {
    const file = path.join(root, relative);
    await fs.rm(file, { force: true });
    await fs.symlink(
      absolute || process.platform === "win32" ? target : path.relative(path.dirname(file), target),
      file,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await writeFixtureTree(root, {
    "node_modules/.modules.yaml": JSON.stringify({
      virtualStoreDir:
        process.platform === "win32"
          ? virtualStore
          : path.relative(path.join(root, "node_modules"), virtualStore),
    }),
    "dist/entry.js": runtimeImports
      .map((specifier) => `console.log(require(${JSON.stringify(specifier)}));`)
      .join("\n"),
    "dist/build-info.json": JSON.stringify({ commit: sha, buildId: sha }),
    "dist/.buildstamp": JSON.stringify({ head: sha }),
    "dist/.runtime-postbuildstamp": JSON.stringify({ head: sha }),
    "dist/control-ui/index.html": "ready",
  });
}

export async function expectRuntime(root: string, sha: string, trackedAsset?: string) {
  const child = await processExec.runCommandWithTimeout(
    [process.execPath, path.join(root, "dist", "entry.js")],
    { timeoutMs: 5000 },
  );
  expect(child.code, child.stderr).toBe(0);
  expect(child.stdout.trim().split("\n")).toEqual(runtimeImports.map(() => sha));
  if (trackedAsset) {
    await expectFile(trackedAsset, "original tracked runtime\n");
    expect(await runFixtureGit(root, "diff", "--name-only", "HEAD")).toBe("");
  }
}
