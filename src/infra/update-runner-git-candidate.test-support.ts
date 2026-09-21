import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import * as processExec from "../process/exec.js";
import { pathExists } from "../utils.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { updateGitCheckout } from "./update-runner-git.js";

const { runCommandWithTimeout } = processExec;

export async function resolveCandidateNodeRuntimeForTest(): Promise<{
  path: string;
  version: string;
}> {
  if (!process.versions.bun) {
    return { path: process.execPath, version: process.versions.node };
  }
  const systemNode = await resolveSystemNodeInfo({});
  if (systemNode?.status !== "supported" || !systemNode.version) {
    throw new Error("This candidate runtime test requires a supported system Node");
  }
  return { path: systemNode.path, version: systemNode.version };
}

export async function expectCancelledGitCandidateCleanup({
  phase,
  fixture: { localRoot, baseSha, targetSha },
  pnpmVersion,
  runRealGit,
}: {
  phase: "build" | "locked worktree creation";
  fixture: { localRoot: string; baseSha: string; targetSha: string };
  pnpmVersion: string;
  runRealGit: (cwd: string, ...args: string[]) => Promise<string>;
}) {
  const controller = new AbortController();
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
        commandRunner.runCommand(argv, {
          ...options,
          signal: options.signal ?? controller.signal,
        }),
      opts: {
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: targetSha },
        inspectGitTarget: async () => {},
        beforeGitMutation,
      },
    });
    expect(controller.signal.reason).toBe(stopped);
    expect(result.status).toBe("error");
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
  for (const file of [
    path.join(external, "index.js"),
    path.join(virtualPackage, "index.js"),
    path.join(root, "node_modules", "identity.cjs"),
    path.join(root, "packages", "runtime", "node_modules", "nested.cjs"),
    path.join(root, "dist-runtime", "identity.cjs"),
    path.join(root, "packages", "runtime", "dist-runtime", "identity.cjs"),
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `module.exports = ${JSON.stringify(sha)};`);
  }
  await fs.rm(path.join(root, "node_modules", "workspace-runtime"), { force: true });
  await fs.symlink(
    path.join(root, "packages", "runtime"),
    path.join(root, "node_modules", "workspace-runtime"),
    "junction",
  );
  for (const [relative, target, absolute] of [
    ["node_modules/relative-workspace-runtime", path.join(root, "packages", "runtime"), false],
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
  await Promise.all([
    fs.writeFile(
      path.join(root, "node_modules", ".modules.yaml"),
      JSON.stringify({
        virtualStoreDir:
          process.platform === "win32"
            ? virtualStore
            : path.relative(path.join(root, "node_modules"), virtualStore),
      }),
    ),
    fs.writeFile(
      path.join(dist, "entry.js"),
      runtimeImports
        .map((specifier) => `console.log(require(${JSON.stringify(specifier)}));`)
        .join("\n"),
    ),
    fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha, buildId: sha })),
    fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready"),
  ]);
}

export async function expectRuntime(root: string, sha: string) {
  const child = await processExec.runCommandWithTimeout(
    [process.execPath, path.join(root, "dist", "entry.js")],
    {
      timeoutMs: 5000,
    },
  );
  expect(child.code, child.stderr).toBe(0);
  expect(child.stdout.trim().split("\n")).toEqual(runtimeImports.map(() => sha));
}
