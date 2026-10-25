import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as processExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveVersionFromModuleUrl } from "../version.js";
import { checkUpdateStatus, resolveUpdateInstallKind } from "./update-check.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";

const runCommandWithTimeout = processExec.runCommandWithTimeout;

const inspectStatus = (
  root: string | null,
  options: Omit<Parameters<typeof checkUpdateStatus>[0], "root" | "includeRegistry"> = {},
) => checkUpdateStatus({ root, includeRegistry: false, ...options });

const writeJson = (file: string, value: object) => fs.writeFile(file, JSON.stringify(value));

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function initGitRepo(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await runGit(root, "init", "--initial-branch=main");
  await runGit(root, "config", "user.name", "OpenClaw Test");
  await runGit(root, "config", "user.email", "test@openclaw.invalid");
}

const it = baseIt.extend<{ base: string; repo: string }>({
  base: ({ task: _task }, use) => withTestDir({ prefix: "openclaw-update-check-" }, use),
  repo: async ({ base }, use) => {
    await initGitRepo(base);
    await runGit(base, "commit", "--allow-empty", "--message", "initial");
    await use(base);
  },
});

async function cloneRepo(base: string) {
  const source = path.join(base, "source");
  const local = path.join(base, "local");
  await initGitRepo(source);
  await runGit(source, "commit", "--allow-empty", "--message", "initial");
  await runGit(base, "clone", "--quiet", source, local);
  return local;
}

function holdGit(matches: (argv: string[]) => boolean) {
  const started = createDeferred();
  const release = createDeferred();
  const commands = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      if (matches(argv)) {
        started.resolve();
        await release.promise;
      }
      return runCommandWithTimeout(argv, options);
    });
  return { started, release, commands };
}

async function install(root: string, manager = "pnpm@12.0.0", lockfiles: readonly string[] = []) {
  await fs.mkdir(root, { recursive: true });
  await writeJson(path.join(root, "package.json"), { name: "openclaw", packageManager: manager });
  for (const lockfile of lockfiles) {
    await fs.writeFile(path.join(root, lockfile), "lock");
  }
  if (lockfiles.length) {
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  }
}

async function createNpmInstallRoot(base: string): Promise<string> {
  const prefix = path.join(base, ".npm-global");
  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const modules = process.platform === "win32" ? "node_modules" : "lib/node_modules";
  const root = path.join(prefix, modules, "openclaw");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\n");
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "openclaw.cmd"),
      '@node "%~dp0\\node_modules\\openclaw\\openclaw.mjs" %*\r\n',
    );
  } else {
    await fs.symlink("../lib/node_modules/openclaw/openclaw.mjs", path.join(binDir, "openclaw"));
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("reports verified Git artifacts independently of target freshness", async ({ base: root }) => {
  await initGitRepo(root);
  const manifest = (version: string) =>
    writeJson(path.join(root, "package.json"), { name: "openclaw", version });
  await manifest("2026.9.1");
  await fs.writeFile(path.join(root, ".gitignore"), "dist/\n");
  await runGit(root, "add", ".");
  await runGit(root, "commit", "--allow-empty", "--message", "initial");
  const sha = await runGit(root, "rev-parse", "HEAD");
  const readStatus = () => inspectStatus(root, { fetchGit: true });
  expect((await readStatus()).git?.artifacts).toEqual({ ready: false });

  const dist = path.join(root, "dist");
  const buildInfo = (value: object) => writeJson(path.join(dist, "build-info.json"), value);
  await fs.mkdir(path.join(dist, "control-ui", "assets"), { recursive: true });
  const build = { version: "2026.9.1", buildId: "fixture-build" };
  const files = {
    "build-info.json": JSON.stringify({ commit: sha, ...build }),
    ".buildstamp": JSON.stringify({ head: sha }),
    ".runtime-postbuildstamp": JSON.stringify({ head: sha }),
    "entry.js": "export {};",
    "control-ui/index.html": '<script src="./assets/main.js"></script>',
    "control-ui/assets/main.js": "export {};",
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dist, file), content);
  }
  const ready = { ready: true, ...build };
  expect((await readStatus()).git).toMatchObject({
    sha,
    builtSha: sha,
    artifacts: ready,
    upstreamSha: null,
  });
  await manifest("2026.9.2");
  expect(resolveVersionFromModuleUrl(pathToFileURL(path.join(dist, "entry.js")).href)).toBe(
    "2026.9.1",
  );
  expect((await readStatus()).git).toMatchObject({ dirty: true, artifacts: ready });
  expect(await verifyGitUpdateRecovery({ root, sha })).toEqual({
    serviceRestartSafe: true,
    ...build,
    version: "2026.9.2",
  });
  await buildInfo({ commit: sha, buildId: "fixture-build" });
  expect((await readStatus()).git?.artifacts).toEqual({ ...ready, version: "2026.9.2" });
  const rebuilt = { version: "2026.9.2", buildId: "rebuilt-fixture" };
  await buildInfo({ commit: sha, ...rebuilt });
  expect((await readStatus()).git?.artifacts).toEqual({ ready: true, ...rebuilt });
  await fs.writeFile(path.join(dist, "build-info.json"), files["build-info.json"]);
  await manifest("2026.9.1");
  for (const [file, content] of Object.entries(files)) {
    await fs.rm(path.join(dist, file));
    expect((await readStatus()).git?.artifacts, file).toEqual({ ready: false });
    await fs.writeFile(path.join(dist, file), content);
  }
  for (const invalidInfo of [{ commit: sha }, { commit: "stale", buildId: "fixture-build" }]) {
    await buildInfo(invalidInfo);
    expect((await readStatus()).git?.artifacts).toEqual({ ready: false });
  }
  await fs.writeFile(path.join(dist, "build-info.json"), files["build-info.json"]);
  await runGit(root, "remote", "add", "origin", path.join(root, "missing-upstream"));
  await runGit(root, "config", "branch.main.remote", "origin");
  await runGit(root, "config", "branch.main.merge", "refs/heads/main");
  expect((await readStatus()).git).toMatchObject({
    artifacts: ready,
    fetchOk: false,
    upstreamSha: null,
  });
});

it.for([
  {
    remoteUrl: "https://example-user:example-password@github.com/example/openclaw.git",
    expected: "https://github.com/example/openclaw",
  },
  { remoteUrl: "repos/openclaw", expected: undefined },
])(
  "reports a credential-free GitHub repository for $remoteUrl",
  async ({ remoteUrl, expected }, { repo: root }) => {
    await runGit(root, "remote", "add", "origin", "https://github.com/other/unrelated.git");
    await runGit(root, "remote", "add", "upstream", remoteUrl);
    await runGit(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
    await runGit(root, "branch", "--set-upstream-to=upstream/main", "main");
    const status = await inspectStatus(root, { fetchGit: false });
    expect(status.git?.repositoryUrl).toBe(expected);
    await runGit(root, "checkout", "--detach");
    const detached = await inspectStatus(root, {
      fetchGit: false,
      useDetachedDevUpstream: true,
    });
    expect(detached.git?.repositoryUrl).toBe(expected);
  },
);

it.for([
  { scope: "install kind", commands: 1 },
  { scope: "full status", commands: 5 },
] as const)(
  "joins $scope Git discovery before reporting cancellation",
  async ({ scope, commands }, { repo: root }) => {
    const started = createDeferred();
    const gates: ReturnType<typeof createDeferred<void>>[] = [];
    const terminations: string[] = [];
    const controller = new AbortController();
    const reason = new Error("update discovery stopped");
    const gitCallsAfterAbort: string[][] = [];
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (controller.signal.aborted) {
        gitCallsAfterAbort.push(argv);
      }
      if (
        gates.length < commands &&
        (scope === "install kind" || !argv.includes("--show-toplevel"))
      ) {
        const gate = createDeferred();
        gates.push(gate);
        if (gates.length === commands) {
          started.resolve();
        }
        await gate.promise;
        const result = await runCommandWithTimeout(argv, options);
        terminations.push(result.termination);
        return result;
      }
      return runCommandWithTimeout(argv, options);
    });
    const settled = vi.fn();
    const pending =
      scope === "install kind"
        ? resolveUpdateInstallKind(root, { signal: controller.signal })
        : inspectStatus(root, { signal: controller.signal });
    const outcome = pending
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(settled);
    try {
      await started.promise;
      controller.abort(reason);
      if (commands > 1) {
        for (const gate of gates.slice(0, commands === 5 ? 2 : 1)) {
          gate.resolve();
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(settled).not.toHaveBeenCalled();
      for (const gate of gates) {
        gate.resolve();
      }
      await expect(outcome).resolves.toBe(reason);
      expect(terminations).toEqual(Array(commands).fill("signal"));
      expect(gitCallsAfterAbort).toEqual([]);
    } finally {
      for (const gate of gates) {
        gate.resolve();
      }
      await outcome;
    }
  },
);

it("starts worktree inspection before Git identity resolves", async ({ repo: root }) => {
  const { started, release, commands } = holdGit(
    (argv) => argv.includes("--abbrev-ref") || argv.includes("describe"),
  );
  const pending = inspectStatus(root, { timeoutMs: 5000 });
  try {
    await started.promise;
    expect(commands.mock.calls.some(([argv]) => argv.includes("status"))).toBe(true);
  } finally {
    release.resolve();
    await pending;
  }
});

it("uses the Dev default only for opted-in detached checkouts", async ({ base }) => {
  const localRoot = await cloneRepo(base);
  const targetSha = await runGit(localRoot, "rev-parse", "HEAD");
  await runGit(localRoot, "checkout", "--detach", targetSha);
  await runGit(localRoot, "branch", "-D", "main");
  const readStatus = (detached: boolean) =>
    inspectStatus(localRoot, {
      fetchGit: true,
      timeoutMs: 5000,
      useDetachedDevUpstream: detached,
    });
  expect((await readStatus(true)).git).toMatchObject({
    branch: "HEAD",
    sha: targetSha,
    upstream: "origin/main",
    upstreamSha: targetSha,
    ahead: 0,
    behind: 0,
    fetchOk: true,
  });
  expect((await readStatus(false)).git).toMatchObject({
    branch: "HEAD",
    upstream: null,
    upstreamSha: null,
  });
  await runGit(localRoot, "checkout", "-b", "feature", targetSha);
  expect((await readStatus(true)).git).toMatchObject({
    branch: "feature",
    upstream: null,
    upstreamSha: null,
    ahead: null,
    behind: null,
  });
});

it("checks the registry while Git freshness is still pending", async ({ base }) => {
  const localRoot = await cloneRepo(base);
  await runGit(localRoot, "tag", "v2000.1.1");
  const { started, release } = holdGit((argv) => argv[0] === "git" && argv.includes("fetch"));
  const registryFetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ version: "2000.1.2" }));
  const resolveRegistryChannel = vi.fn(() => "stable" as const);
  const pending = checkUpdateStatus({
    root: localRoot,
    includeRegistry: true,
    fetchGit: true,
    timeoutMs: 5000,
    resolveRegistryChannel,
  });
  try {
    await started.promise;
    expect(resolveRegistryChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        installKind: "git",
        git: expect.objectContaining({ branch: "main", tag: "v2000.1.1" }),
      }),
    );
    expect(registryFetch).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await pending;
  }
  expect((await pending).git).toMatchObject({ fetchOk: true, ahead: 0, behind: 0 });
});

it("returns unknown install status when root is missing", async () => {
  await expect(inspectStatus(null, { timeoutMs: 1000 })).resolves.toEqual({
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
    registry: undefined,
  });
});

it.for([
  { kind: "npm", lockfiles: ["package-lock.json"] },
  { kind: "bun", lockfiles: ["bun.lockb"] },
  { kind: "bun", lockfiles: ["bun.lock", "bun.lockb"] },
  { kind: "lockless npm", lockfiles: [] },
  { kind: "unmanaged", lockfiles: [] },
] as const)("reports $kind with $lockfiles", async ({ kind, lockfiles }, { base }) => {
  const root =
    kind === "bun"
      ? path.join(base, ".bun", "install", "global", "node_modules", "openclaw")
      : kind === "unmanaged"
        ? path.join(base, "copied", "node_modules", "openclaw")
        : await createNpmInstallRoot(base);
  const manager = kind === "bun" ? "bun" : kind === "unmanaged" ? "unknown" : "npm";
  await install(
    root,
    kind === "npm" ? "npm@10.0.0" : kind === "bun" ? "bun@1.2.0" : undefined,
    lockfiles,
  );
  const resolveRegistryChannel = vi.fn(() => "extended-stable" as const);
  const env = kind === "lockless npm" ? { BUN_INSTALL: path.join(base, "custom-bun-home") } : {};
  await withEnvAsync(env, async () => {
    const status = await inspectStatus(root, {
      fetchGit: false,
      timeoutMs: 1000,
      resolveRegistryChannel,
    });
    expect(status).toMatchObject({
      root,
      installKind: "package",
      packageManager: manager,
      git: undefined,
      registry: undefined,
      deps: {
        manager,
        ...(kind === "bun"
          ? {
              status: "ok",
              lockfilePath: path.join(root, lockfiles[0]),
              markerPath: path.join(root, "node_modules"),
            }
          : kind === "lockless npm"
            ? {
                status: "unknown",
                reason: "lockfile missing",
                lockfilePath: path.join(root, "package-lock.json"),
              }
            : kind === "unmanaged"
              ? { reason: "unknown package manager" }
              : {}),
      },
    });
    expect(resolveRegistryChannel).toHaveBeenCalledWith({
      installKind: "package",
      git: undefined,
    });
  });
});

it("reports a missing dependency marker and accepts an older valid marker", async ({ base }) => {
  const globalProject = path.join(base, "pnpm", "global", "5");
  const globalRoot = path.join(globalProject, "node_modules");
  const root = path.join(globalRoot, "openclaw");
  await install(root);
  await fs.writeFile(path.join(globalProject, "pnpm-lock.yaml"), "lock");
  await fs.writeFile(path.join(globalRoot, ".modules.yaml"), "marker");
  const lockfilePath = path.join(root, "pnpm-lock.yaml");
  await fs.writeFile(lockfilePath, "lock", "utf8");

  const missing = await inspectStatus(root, { fetchGit: false, timeoutMs: 1000 });
  expect(missing.deps).toMatchObject({
    manager: "pnpm",
    status: "missing",
    reason: "node_modules marker missing",
  });

  const markerPath = path.join(root, "node_modules", ".modules.yaml");
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, "marker", "utf8");
  const staleDate = new Date(Date.now() - 10_000);
  const freshDate = new Date();
  await fs.utimes(markerPath, staleDate, staleDate);
  await fs.utimes(lockfilePath, freshDate, freshDate);

  const installed = await inspectStatus(root, { fetchGit: false, timeoutMs: 1000 });
  expect(installed.deps).toMatchObject({ manager: "pnpm", status: "ok" });
});
