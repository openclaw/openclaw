import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { copyTreeCloseOnExec } from "../../test/helpers/close-on-exec-copy.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import * as processExec from "../process/exec.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { pathExists } from "../utils.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type {
  CommandRunner,
  UpdateRunResult,
  UpdateRunnerOptions,
  UpdateStepProgress,
} from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const { runCommandWithTimeout } = processExec;

export type GitCandidateFixture = {
  directory: string;
  root: string;
  beforeSha: string;
  events: string[];
  virtualStoreLayout: VirtualStoreLayout;
  isStopped: () => boolean;
  advanceRemote: () => Promise<string>;
  runCommand: CommandRunner;
  setRunCommand: (runner: CommandRunner) => void;
  update: (opts?: Partial<UpdateRunnerOptions>) => Promise<UpdateRunResult>;
  expectNoRuntimeStagingPaths: () => Promise<void>;
};

export function isolateGitIdentity() {
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  for (const role of ["AUTHOR", "COMMITTER"]) {
    for (const field of ["NAME", "EMAIL"]) {
      vi.stubEnv(`GIT_${role}_${field}`, undefined);
    }
  }
}

export async function writeFixtureTree(root: string, files: Record<string, string>) {
  for (const [file, contents] of Object.entries(files)) {
    const destination = path.join(root, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
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

export async function createGitFixtureCheckout(
  directory: string,
  manifest: Record<string, unknown> = {},
) {
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

export async function advanceFixtureRemote(remote: string) {
  await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
  await runFixtureGit(remote, "add", ".");
  await runFixtureGit(remote, "commit", "-m", "candidate");
  return runFixtureGit(remote, "rev-parse", "HEAD");
}

export async function prepareDeletedTrackedRuntimeAsset(remote: string, root: string) {
  const asset = "dist/tracked-runtime.txt";
  await fs.mkdir(path.join(remote, "dist"));
  await fs.writeFile(path.join(remote, asset), "original tracked runtime\n");
  await runFixtureGit(remote, "add", "-f", asset);
  await runFixtureGit(remote, "commit", "-m", "tracked runtime");
  await runFixtureGit(root, "pull", "--ff-only");
  const beforeSha = await runFixtureGit(root, "rev-parse", "HEAD");
  await runFixtureGit(remote, "rm", asset);
  return { beforeSha, asset: path.join(root, asset) };
}

export async function resolveCandidateNodeRuntimeForTest() {
  if (!process.versions.bun) {
    return { path: process.execPath, version: process.versions.node };
  }
  const nodePath = resolveTestNodeExecPath();
  const node = await resolveNodeRuntimeInfo(nodePath);
  if (node.status !== "supported" || !node.version) {
    throw new Error("This candidate runtime test requires a supported Node");
  }
  return { path: nodePath, version: node.version };
}

export async function expectCancelledGitCandidateCleanup({
  phase,
  fixture: { localRoot, baseSha, targetSha },
  pnpmVersion,
  runRealGit,
  progress,
  onAbort,
}: {
  phase: "build" | "locked worktree creation";
  fixture: { localRoot: string; baseSha: string; targetSha: string };
  pnpmVersion: string;
  runRealGit: (cwd: string, ...args: string[]) => Promise<string>;
  progress?: UpdateStepProgress;
  onAbort?: () => void;
}) {
  const controller = new AbortController();
  if (onAbort) {
    controller.signal.addEventListener("abort", onAbort, { once: true });
  }
  const stopped = new Error("preflight owner stopped");
  const beforeGitMutation = vi.fn(async () => {
    throw new Error("cancelled update reached mutation");
  });
  let buildResult: Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined;
  let worktree: string | undefined;
  const commandSpy = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockImplementation(async (argv, optionsOrTimeout) => {
      const options =
        typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
      if (argv[0] !== "pnpm") {
        const result = await runCommandWithTimeout(argv, options);
        if (
          phase === "locked worktree creation" &&
          argv.includes("worktree") &&
          argv.includes("add")
        ) {
          worktree = argv.at(-2);
          assert.ok(worktree);
          // Git can retain this lock when creation is forcibly terminated during checkout.
          await runRealGit(worktree, "worktree", "lock", "--reason", "initializing", worktree);
          controller.abort(stopped);
        }
        if (argv.includes("worktree") && argv.includes("remove")) {
          assert.ok(options.cwd);
          expect(result.code).toBe(0);
          expect(await runRealGit(options.cwd, "worktree", "list", "--porcelain")).not.toContain(
            worktree,
          );
        }
        return result;
      }
      if (argv[1] === "build") {
        worktree = options.cwd;
        buildResult = await runCommandWithTimeout(
          [process.execPath, "-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
          { ...options, onOutputChunk: () => controller.abort(stopped) },
        );
        return buildResult;
      }
      return {
        stdout: argv[1] === "--version" ? pnpmVersion : "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        noOutputTimedOut: false,
      };
    });
  try {
    const commandRunner = await buildUpdateCommandRunner();
    const result = await updateGitCheckout({
      ...commandRunner,
      gitRoot: localRoot,
      timeoutMs: 5000,
      startedAt: Date.now(),
      runCommand: (argv, options) =>
        commandRunner.runCommand(argv, { ...options, signal: options.signal ?? controller.signal }),
      opts: {
        progress,
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: targetSha },
        inspectGitTarget: async () => {},
        validateCandidate: async () => {
          throw new Error("cancelled update reached validation");
        },
        beforeGitMutation,
        runGitDoctor: async () => {
          throw new Error("cancelled update reached Doctor");
        },
      },
    }).catch((error: unknown) => {
      if (
        !progress ||
        !controller.signal.aborted ||
        hasCommandProcessCleanupError(error) ||
        !collectNestedErrorCandidates(error).some(
          (cause) => cause instanceof UpdateRequesterRevokedError,
        )
      ) {
        throw error;
      }
      return undefined;
    });
    expect(controller.signal.reason).toBe(stopped);
    if (result) {
      expect(result.status).toBe("error");
    }
    expect(beforeGitMutation).not.toHaveBeenCalled();
  } finally {
    commandSpy.mockRestore();
  }
  if (phase === "build") {
    expect(buildResult?.termination).toBe("signal");
  }
  assert.ok(worktree);
  expect(await pathExists(path.dirname(worktree))).toBe(false);
  expect(await runRealGit(localRoot, "worktree", "list", "--porcelain")).not.toContain(worktree);
  expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(baseSha);
}

export const runtimeImports = [
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

export type VirtualStoreLayout =
  | "node_modules/.pnpm"
  | "node_modules/.cache/jiti"
  | "node_modules/.vite/deps"
  | ".pnpm"
  | "cache/deps"
  | "../store"
  | "external"
  | "symlink";

export async function writeRuntime(directory: string, sha: string, store: string, layout: string) {
  const root = await fs.realpath(directory);
  const dist = path.join(root, "dist");
  const external = path.join(store, sha);
  await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
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
  await writeFixtureFiles(root, {
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

export function registerGitRuntimeStagingTests(getFixture: () => GitCandidateFixture) {
  it("omits generated tool caches while preserving runtime files during promotion", async () => {
    const { root, isStopped, advanceRemote, update, expectNoRuntimeStagingPaths } = getFixture();
    const target = await advanceRemote();
    const stagingProgress: string[] = [];
    const contents = "keep or regenerate";
    const copy = fs.cp.bind(fs);
    vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
      if (String(args[1]).includes(".openclaw-update-")) {
        expect(stagingProgress).toEqual(["start"]);
        expect(isStopped()).toBe(false);
      }
      return copy(...args);
    });
    const omitted = [
      "node_modules/.cache/jiti",
      "node_modules/.vite",
      "node_modules/.vite-temp",
      "ui/node_modules/.cache/jiti",
    ];
    const retained = [
      "node_modules/.cache/other-tool",
      "node_modules/package/.cache/jiti",
      "node_modules/package/.vite",
      "packages/runtime/node_modules/.cache/jiti",
      "dist/.cache/jiti",
      "dist-runtime/.vite",
    ];
    const markStage =
      (event: string) =>
      ({ name }: { name: string }) => {
        if (name === "preflight-runtime-stage") {
          stagingProgress.push(event);
        }
      };
    const result = await update({
      progress: {
        onStepStart: markStage("start"),
        onStepComplete: markStage("complete"),
      },
      validateCandidate: async (candidateRoot) => {
        await writeFixtureTree(
          candidateRoot,
          Object.fromEntries(
            [...omitted, ...retained].map((relative) => [`${relative}/content`, contents]),
          ),
        );
        await expectRuntime(candidateRoot, target);
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(stagingProgress).toEqual(["start", "complete"]);
    expectStep(result.steps, {
      name: "preflight-runtime-stage",
      exitCode: 0,
      durationMs: expect.any(Number),
    });
    for (const relative of omitted) {
      await expectMissing(path.join(root, relative));
    }
    for (const relative of retained) {
      await expectFile(path.join(root, relative, "content"), contents);
    }
    await expectRuntime(root, target);
    await expectNoRuntimeStagingPaths();
  });

  it.each(["validation", "runtime staging"])(
    "leaves the old runtime serving when candidate %s fails",
    async (failurePoint) => {
      const { root, beforeSha, isStopped, advanceRemote, update, expectNoRuntimeStagingPaths } =
        getFixture();
      await advanceRemote();
      const failure = new Error("candidate canary failed");
      const onStepComplete = vi.fn();
      const cause: unknown = await update({
        progress: {
          onStepComplete,
          onStepStart: ({ name }) => {
            if (failurePoint === "runtime staging" && name === "preflight-cleanup") {
              expect(onStepComplete).toHaveBeenCalledWith(
                expect.objectContaining({
                  name: "preflight-runtime-stage",
                  exitCode: 1,
                  failureFacts: [expect.objectContaining({ check: "preflight-runtime-stage" })],
                }),
              );
            }
          },
        },
        validateCandidate: async () => {
          if (failurePoint === "validation") {
            throw failure;
          }
          vi.spyOn(fs, "cp").mockRejectedValueOnce(failure);
        },
      }).catch((error: unknown) => error);
      if (failurePoint === "validation") {
        expect(cause).toBe(failure);
      } else {
        const { resolveMutableUpdateFailure } =
          await import("../cli/update-cli/update-command-result.js");
        const { result } = await resolveMutableUpdateFailure({
          cause,
          durationMs: 0,
          mode: "git",
          root,
          originalRecovery: () => verifyGitUpdateRecovery({ root, sha: beforeSha }),
        });
        expect(result.recovery).toMatchObject({ serviceRestartSafe: true, buildId: beforeSha });
      }
      expect(isStopped()).toBe(false);
      await expectHead(root, beforeSha);
      expect(await readText(path.join(root, "node_modules", "identity.cjs"))).toContain(beforeSha);
      await expectNoRuntimeStagingPaths();
    },
  );
}

export function registerGitRuntimeRestorationTests(getFixture: () => GitCandidateFixture) {
  it.each([false, true])(
    "retries partial runtime restoration without losing originals (cleanup first: %s)",
    async (cleanupFirst) => {
      const { directory, root, beforeSha, virtualStoreLayout, advanceRemote, runCommand } =
        getFixture();
      const candidateSha = await advanceRemote();
      await runFixtureGit(root, "fetch", "origin");
      const cleanupRoot = path.join(directory, "restore-candidate");
      const candidateRoot = path.join(cleanupRoot, "worktree");
      await fs.mkdir(cleanupRoot);
      await runFixtureGit(root, "worktree", "add", "--detach", candidateRoot, candidateSha);
      await writeRuntime(
        candidateRoot,
        candidateSha,
        path.join(directory, "shared-store"),
        virtualStoreLayout,
      );
      await expectRuntime(candidateRoot, candidateSha);
      const promotion = await prepareGitRuntimePromotion(
        root,
        candidateRoot,
        runCommand,
        5000,
        cleanupRoot,
      );
      await runFixtureGit(root, "worktree", "remove", "--force", candidateRoot);
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      const rename = fs.rename.bind(fs);
      let distBackup: string | undefined;
      let rejectRestore = true;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (source === path.join(root, "dist")) {
          distBackup = String(destination);
        }
        if (rejectRestore && source === distBackup && destination === path.join(root, "dist")) {
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(path.join(destination, "restore-race"), "occupied");
        }
        return rename(source, destination);
      });
      await promotion.activate();
      await expectRuntime(root, candidateSha);
      await expect(promotion.restore()).rejects.toThrow();
      if (cleanupFirst) {
        await promotion.cleanup();
      }
      assert(distBackup, "The original dist backup was not observed.");
      expect(JSON.parse(await readText(path.join(distBackup, "build-info.json")))).toMatchObject({
        commit: beforeSha,
      });
      expect(await readText(path.join(root, "node_modules", "identity.cjs"))).toContain(beforeSha);
      rejectRestore = false;
      await promotion.restore();
      await expectRuntime(root, beforeSha);
      await promotion.cleanup();
      await expectMissing(path.dirname(distBackup));
    },
  );
}

export async function expectNoGitRuntimeStagingPaths(root: string, inspectionRoots: string[]) {
  for (const inspectionRoot of inspectionRoots) {
    await expectMissing(inspectionRoot);
  }
  const entries = await fs.readdir(root, { recursive: true });
  expect(
    entries.filter((entry) =>
      /\.openclaw-update-[0-9a-f]{8}-[0-9a-f-]{27}\.tmp(?:\/|$)/u.test(entry),
    ),
  ).toEqual([]);
}
