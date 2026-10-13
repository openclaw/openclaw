// Covers install, dependency, and Git update status.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as processExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveVersionFromModuleUrl } from "../version.js";
import {
  checkUpdateStatus,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
} from "./update-check.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";

const runCommandWithTimeout = processExec.runCommandWithTimeout;
const PNPM_PACKAGE_MANAGER = "pnpm@12.0.0";

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd,
    timeoutMs: 5000,
  });
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

async function commitGit(root: string, message: string): Promise<void> {
  await runGit(root, "commit", "--allow-empty", "--message", message);
}

async function createNpmInstallRoot(base: string): Promise<string> {
  const prefix = path.join(base, ".npm-global");
  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const root = path.join(
    prefix,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "openclaw",
  );
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
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

describe("checkUpdateStatus", () => {
  it("reports verified Git artifacts independently of target freshness", async () => {
    await withTestDir({ prefix: "openclaw-update-artifacts-" }, async (root) => {
      await initGitRepo(root);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
      );
      await fs.writeFile(path.join(root, ".gitignore"), "dist/\n");
      await runGit(root, "add", ".");
      await commitGit(root, "initial");
      const sha = await runGit(root, "rev-parse", "HEAD");
      const readStatus = () => checkUpdateStatus({ root, includeRegistry: false, fetchGit: true });
      expect((await readStatus()).git?.artifacts).toEqual({ ready: false });

      const dist = path.join(root, "dist");
      await fs.mkdir(path.join(dist, "control-ui", "assets"), { recursive: true });
      const files = {
        "build-info.json": JSON.stringify({
          commit: sha,
          version: "2026.9.1",
          buildId: "fixture-build",
        }),
        ".buildstamp": JSON.stringify({ head: sha }),
        ".runtime-postbuildstamp": JSON.stringify({ head: sha }),
        "entry.js": "export {};",
        "control-ui/index.html": '<script src="./assets/main.js"></script>',
        "control-ui/assets/main.js": "export {};",
      };
      for (const [file, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dist, file), content);
      }
      const ready = { ready: true, version: "2026.9.1", buildId: "fixture-build" };
      expect((await readStatus()).git).toMatchObject({
        sha,
        builtSha: sha,
        artifacts: ready,
        upstreamSha: null,
      });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
      );
      expect(resolveVersionFromModuleUrl(pathToFileURL(path.join(dist, "entry.js")).href)).toBe(
        "2026.9.1",
      );
      expect((await readStatus()).git).toMatchObject({ dirty: true, artifacts: ready });
      expect(await verifyGitUpdateRecovery({ root, sha })).toEqual({
        serviceRestartSafe: true,
        version: "2026.9.2",
        buildId: "fixture-build",
      });
      await fs.writeFile(
        path.join(dist, "build-info.json"),
        JSON.stringify({ commit: sha, buildId: "fixture-build" }),
      );
      expect((await readStatus()).git?.artifacts).toEqual({ ...ready, version: "2026.9.2" });
      await fs.writeFile(
        path.join(dist, "build-info.json"),
        JSON.stringify({ commit: sha, version: "2026.9.2", buildId: "rebuilt-fixture" }),
      );
      expect((await readStatus()).git?.artifacts).toEqual({
        ready: true,
        version: "2026.9.2",
        buildId: "rebuilt-fixture",
      });
      await fs.writeFile(path.join(dist, "build-info.json"), files["build-info.json"]);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
      );
      for (const [file, content] of Object.entries(files)) {
        await fs.rm(path.join(dist, file));
        expect((await readStatus()).git?.artifacts, file).toEqual({ ready: false });
        await fs.writeFile(path.join(dist, file), content);
      }
      for (const buildInfo of [{ commit: sha }, { commit: "stale", buildId: "fixture-build" }]) {
        await fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify(buildInfo));
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
  });

  it.each([
    {
      remoteUrl: "https://example-user:example-password@github.com/example/openclaw.git",
      expected: "https://github.com/example/openclaw",
    },
    { remoteUrl: "repos/openclaw", expected: undefined },
  ])(
    "reports a credential-free GitHub repository for $remoteUrl",
    async ({ remoteUrl, expected }) => {
      await withTestDir({ prefix: "openclaw-update-repository-" }, async (root) => {
        await initGitRepo(root);
        await commitGit(root, "initial");
        await runGit(root, "remote", "add", "origin", "https://github.com/other/unrelated.git");
        await runGit(root, "remote", "add", "upstream", remoteUrl);
        await runGit(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
        await runGit(root, "branch", "--set-upstream-to=upstream/main", "main");
        const status = await checkUpdateStatus({ root, includeRegistry: false, fetchGit: false });
        expect(status.git?.repositoryUrl).toBe(expected);
        await runGit(root, "checkout", "--detach");
        const detached = await checkUpdateStatus({
          root,
          includeRegistry: false,
          fetchGit: false,
          useDetachedDevUpstream: true,
        });
        expect(detached.git?.repositoryUrl).toBe(expected);
      });
    },
  );

  it.each([
    { scope: "install kind", commands: 1 },
    { scope: "identity", commands: 2 },
    { scope: "full status", commands: 5 },
  ] as const)(
    "joins $scope Git discovery before reporting cancellation",
    async ({ scope, commands }) => {
      await withTestDir({ prefix: "openclaw-update-check-cancel-" }, async (root) => {
        await initGitRepo(root);
        await commitGit(root, "initial");
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
        let settled = false;
        const pending =
          scope === "install kind"
            ? resolveUpdateInstallKind(root, { signal: controller.signal })
            : scope === "identity"
              ? resolveUpdateInstallIdentity({ root, signal: controller.signal })
              : checkUpdateStatus({ root, includeRegistry: false, signal: controller.signal });
        const outcome = pending.then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
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
          expect(settled).toBe(false);
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
      });
    },
  );

  it("starts full-status worktree inspection before Git identity resolves", async () => {
    await withTestDir({ prefix: "openclaw-update-check-local-overlap-" }, async (root) => {
      await initGitRepo(root);
      await commitGit(root, "initial");
      const identityStarted = createDeferred();
      const releaseIdentity = createDeferred();
      const commands = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          if (argv.includes("--abbrev-ref") || argv.includes("describe")) {
            identityStarted.resolve();
            await releaseIdentity.promise;
          }
          return runCommandWithTimeout(argv, options);
        });
      const pending = checkUpdateStatus({ root, includeRegistry: false, timeoutMs: 5000 });
      try {
        await identityStarted.promise;
        expect(commands.mock.calls.some(([argv]) => argv.includes("status"))).toBe(true);
      } finally {
        releaseIdentity.resolve();
        await pending;
      }
    });
  });

  it("checks the registry while Git freshness is still pending", async () => {
    await withTestDir({ prefix: "openclaw-update-check-overlap-" }, async (base) => {
      const remoteRoot = path.join(base, "remote");
      const localRoot = path.join(base, "local");
      await initGitRepo(remoteRoot);
      await commitGit(remoteRoot, "initial");
      await runGit(base, "clone", "--quiet", remoteRoot, localRoot);
      await runGit(localRoot, "tag", "v2000.1.1");
      const fetchStarted = createDeferred();
      const releaseFetch = createDeferred();
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        if (argv[0] === "git" && argv.includes("fetch")) {
          fetchStarted.resolve();
          await releaseFetch.promise;
        }
        return runCommandWithTimeout(argv, options);
      });
      const registryFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ version: "2000.1.2" }), {
          headers: { "content-type": "application/json" },
        }),
      );
      const resolveRegistryChannel = vi.fn(() => "stable" as const);
      const pending = checkUpdateStatus({
        root: localRoot,
        includeRegistry: true,
        fetchGit: true,
        timeoutMs: 5000,
        resolveRegistryChannel,
      });
      try {
        await fetchStarted.promise;
        expect(resolveRegistryChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            installKind: "git",
            git: expect.objectContaining({ branch: "main", tag: "v2000.1.1" }),
          }),
        );
        expect(registryFetch).toHaveBeenCalledOnce();
      } finally {
        releaseFetch.resolve();
        await pending;
      }
      expect((await pending).git).toMatchObject({ fetchOk: true, ahead: 0, behind: 0 });
    });
  });

  it("returns unknown install status when root is missing", async () => {
    await expect(
      checkUpdateStatus({ root: null, includeRegistry: false, timeoutMs: 1000 }),
    ).resolves.toEqual({
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: undefined,
    });
  });

  it("detects package installs for non-git roots", async () => {
    await withTestDir({ prefix: "openclaw-update-check-" }, async (base) => {
      const root = await createNpmInstallRoot(base);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(status.root).toBe(root);
      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("npm");
      expect(status.git).toBeUndefined();
      expect(status.registry).toBeUndefined();
      expect(status.deps?.manager).toBe("npm");
    });
  });

  it("resolves a status registry channel after detecting the install kind", async () => {
    await withTestDir({ prefix: "openclaw-update-check-registry-channel-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      const resolveRegistryChannel = vi.fn(() => "extended-stable" as const);

      await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
        resolveRegistryChannel,
      });

      expect(resolveRegistryChannel).toHaveBeenCalledWith({
        installKind: "package",
        git: undefined,
      });
    });
  });

  it.each([
    {
      name: "binary lockfile",
      lockfiles: ["bun.lockb"],
      expectedLockfile: "bun.lockb",
    },
    {
      name: "text lockfile when both formats exist",
      lockfiles: ["bun.lock", "bun.lockb"],
      expectedLockfile: "bun.lock",
    },
  ])("reports dependency status for Bun's $name", async ({ lockfiles, expectedLockfile }) => {
    await withTestDir({ prefix: "openclaw-update-check-bun-" }, async (base) => {
      const root = path.join(base, ".bun", "install", "global", "node_modules", "openclaw");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "bun@1.2.0" }),
        "utf8",
      );
      for (const lockfile of lockfiles) {
        await fs.writeFile(path.join(root, lockfile), "lock", "utf8");
      }
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });

      expect(status).toMatchObject({
        installKind: "package",
        packageManager: "bun",
        deps: {
          manager: "bun",
          lockfilePath: path.join(root, expectedLockfile),
          markerPath: path.join(root, "node_modules"),
          status: "ok",
        },
      });
    });
  });

  it.each([{ manager: "npm", expectedLockfile: "package-lock.json" }])(
    "detects lockless OpenClaw $manager installs despite packed pnpm metadata",
    async ({ manager, expectedLockfile }) => {
      await withTestDir({ prefix: `openclaw-update-check-lockless-${manager}-` }, async (base) => {
        const bunInstall = path.join(base, "custom-bun-home");
        const root =
          manager === "bun"
            ? path.join(bunInstall, "install", "global", "node_modules", "openclaw")
            : await createNpmInstallRoot(base);
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", packageManager: PNPM_PACKAGE_MANAGER }),
          "utf8",
        );

        await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
          const status = await checkUpdateStatus({
            root,
            includeRegistry: false,
            fetchGit: false,
            timeoutMs: 1000,
          });

          expect(status.installKind).toBe("package");
          expect(status.packageManager).toBe(manager);
          expect(status.deps).toMatchObject({
            manager,
            lockfilePath: path.join(root, expectedLockfile),
            status: "unknown",
            reason: "lockfile missing",
          });
        });
      });
    },
  );

  it("does not invent npm ownership for an unmanaged copy with packed pnpm metadata", async () => {
    await withTestDir({ prefix: "openclaw-update-check-unmanaged-" }, async (base) => {
      const root = path.join(base, "copied", "node_modules", "openclaw");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: PNPM_PACKAGE_MANAGER }),
      );

      const status = await checkUpdateStatus({ root, includeRegistry: false, timeoutMs: 1000 });

      expect(status).toMatchObject({
        installKind: "package",
        packageManager: "unknown",
        deps: { manager: "unknown", reason: "unknown package manager" },
      });
    });
  });

  it("reports a missing dependency marker and accepts an older valid marker", async () => {
    await withTestDir({ prefix: "openclaw-update-check-deps-" }, async (base) => {
      const globalProject = path.join(base, "pnpm", "global", "5");
      const globalRoot = path.join(globalProject, "node_modules");
      const root = path.join(globalRoot, "openclaw");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(globalProject, "pnpm-lock.yaml"), "lock");
      await fs.writeFile(path.join(globalRoot, ".modules.yaml"), "marker");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: PNPM_PACKAGE_MANAGER }),
        "utf8",
      );
      const lockfilePath = path.join(root, "pnpm-lock.yaml");
      await fs.writeFile(lockfilePath, "lock", "utf8");

      const missing = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
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

      const installed = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(installed.deps).toMatchObject({
        manager: "pnpm",
        status: "ok",
      });
    });
  });
});
