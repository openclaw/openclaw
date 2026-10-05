import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import {
  createNodeWorkerRepositoryPreparation,
  type NodeWorkerRepositoryExec,
} from "./node-worker-repository-preparation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const FIXTURE_COMMIT = "a".repeat(40);
const FIXTURE_WORKSPACE = "/node/workspace";
const FIXTURE_TOKEN = `ghp_${"x".repeat(36)}`;

it.each(["win32", "linux", "darwin"] as const)(
  "preserves authenticated Git arguments with native long paths on %s",
  async (platform) => {
    const origin = "https://example.invalid/repository.git";
    const spawnSync = vi.fn(() => ({ status: 1 }));
    const repository = createNodeWorkerRepositoryPreparation(async ({ argv, input, seed }) => {
      if (!seed) {
        const gitArgs = argv.slice(4);
        const guestProcess = {
          platform,
          argv: ["node", ...gitArgs],
          env: {
            PATH: "guest-tools",
            Git_CONFIG_COUNT: "1",
            GIT_CONFIG_VALUE_0: "inherited-secret",
            GH_TOKEN: "inherited-token",
            GITHUB_TOKEN: "inherited-token",
          },
          exitCode: 0,
        };
        runInNewContext(argv[2]!, {
          Buffer,
          process: guestProcess,
          require: (id: string) => {
            if (id === "node:fs") {
              return { readFileSync: () => input };
            }
            if (id === "node:child_process") {
              return { spawnSync };
            }
            throw new Error(`Unexpected guest import ${id}`);
          },
        });
        expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
          "git",
          [
            ...(platform === "win32" ? ["-c", "core.longpaths=true"] : []),
            "-c",
            `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`,
            "-c",
            "core.fsmonitor=false",
            ...gitArgs,
          ],
          {
            stdio: ["ignore", "inherit", "inherit"],
            env: {
              PATH: "guest-tools",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "",
              SSH_ASKPASS: "",
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `http.${origin}.extraheader`,
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${FIXTURE_TOKEN}`).toString("base64")}`,
            },
          },
        );
      }
      return {
        stdout: "absent",
        stderr: "",
        code: seed ? 0 : 1,
        signal: null,
        killed: false,
        termination: "exit",
        workspaceDir: FIXTURE_WORKSPACE,
      };
    });
    await expect(
      repository.prepareRepository({ origin, gitToken: FIXTURE_TOKEN }),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "clone-failed",
    });
  },
);

it.each([
  {
    stage: "clone",
    label: "git clone",
    reason: "clone-failed",
    result: {
      code: 128,
      stderr: `fatal: authentication failed ${FIXTURE_TOKEN}\n${"progress ".repeat(300)}check repository access`,
    },
    diagnosis: "check repository access",
  },
  {
    stage: "fetch",
    label: "git fetch",
    reason: "checkout-failed",
    result: { code: null, stderr: " \n", termination: "timeout", signal: "SIGTERM" },
    diagnosis: "timeout (exit code null, signal SIGTERM): no stderr output",
  },
  {
    stage: "rev-parse",
    label: "git rev-parse",
    reason: "checkout-failed",
    result: { code: 128, stderr: "fatal: FETCH_HEAD is unavailable" },
    diagnosis: "FETCH_HEAD is unavailable",
  },
  {
    stage: "--detach",
    label: "git checkout --detach",
    reason: "checkout-failed",
    result: { code: 1, stderr: "error: unable to create file: Permission denied" },
    diagnosis: "Permission denied",
  },
  {
    stage: "-B",
    label: "git checkout -B",
    reason: "checkout-failed",
    result: { code: 128, stderr: "fatal: cannot lock ref" },
    diagnosis: "cannot lock ref",
  },
  {
    stage: "rev-parse",
    label: "git rev-parse",
    reason: "checkout-failed",
    result: { stdout: "not a commit" },
    diagnosis: "invalid commit revision",
  },
  {
    stage: "rev-parse",
    label: "git rev-parse",
    reason: "checkout-failed",
    result: { stdout: "b".repeat(40) },
    diagnosis: "requested commit mismatch",
  },
  {
    stage: "--detach",
    label: "git checkout --detach",
    reason: "checkout-failed",
    result: { workspaceDir: "/node/other-workspace" },
    diagnosis: "workspace directory changed during checkout",
  },
] satisfies Array<{
  stage: string;
  label: string;
  reason: string;
  result: Partial<SpawnResult & { workspaceDir: string }>;
  diagnosis: string;
}>)(
  "preserves bounded, redacted $label failure details: $diagnosis",
  async ({ stage, label, reason, result, diagnosis }) => {
    const exec: NodeWorkerRepositoryExec = async ({ argv, seed }) => ({
      code: 0,
      stderr: "",
      stdout: seed
        ? "absent"
        : argv.includes("rev-parse")
          ? FIXTURE_COMMIT
          : `sha256:${"c".repeat(64)}`,
      termination: "exit",
      signal: null,
      killed: false,
      workspaceDir: FIXTURE_WORKSPACE,
      ...(argv.includes(stage) ? result : {}),
    });
    const prepared = await createNodeWorkerRepositoryPreparation(exec).prepareRepository({
      origin: "https://example.invalid/repository.git",
      commit: FIXTURE_COMMIT,
      branch: "openclaw/session",
    });

    expect(prepared).toMatchObject({ kind: "failed", reason });
    if (prepared.kind !== "failed") {
      throw new Error("Repository preparation unexpectedly succeeded");
    }
    expect(prepared.detail).toContain(
      `${label}: ${result.termination ?? "exit"} (exit code ${result.code === undefined ? 0 : result.code}, signal ${result.signal ?? null})`,
    );
    expect(prepared.detail).toContain(diagnosis);
    expect(prepared.detail).not.toContain(FIXTURE_TOKEN);
    expect(prepared.detail).not.toContain("\n");
    expect(prepared.detail!.length).toBeLessThanOrEqual(1_024);
  },
);

it("reports missing Git from the executable repository helper", async () => {
  const root = await fs.realpath(tempDirs.make("node-repository-missing-git-"));
  const repository = createNodeWorkerRepositoryPreparation(async ({ argv, input, seed }) => {
    if (seed) {
      return {
        stdout: "absent",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        workspaceDir: root,
      };
    }
    const result = await runCommandWithTimeout([process.execPath, ...argv.slice(1)], {
      cwd: root,
      input,
      timeoutMs: 10_000,
      baseEnv: {
        PATH: root,
        HOME: root,
        USERPROFILE: root,
        SystemRoot: process.env.SystemRoot,
      },
    });
    return { ...result, workspaceDir: root };
  });

  await expect(
    repository.prepareRepository({ origin: "https://example.invalid/repository.git" }),
  ).resolves.toMatchObject({
    kind: "failed",
    reason: "clone-failed",
    detail: expect.stringMatching(/git clone: exit \(exit code 1, signal null\): .*ENOENT.*git/u),
  });
});

it("prepares and reuses an exact repository commit without a Gateway workspace", async () => {
  const root = await fs.realpath(tempDirs.make("node-repository-preparation-"));
  const origin = path.join(root, "origin");
  const home = path.join(root, "node-home");
  const gitConfig = path.join(root, "empty.gitconfig");
  await fs.mkdir(origin);
  await fs.writeFile(gitConfig, "");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 10_000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(origin, "init", "--quiet");
  const originalBranch = await git(origin, "symbolic-ref", "--short", "HEAD");
  await fs.writeFile(path.join(origin, "tracked.txt"), "pinned contents\n");
  await git(origin, "add", ".");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "pinned",
  );
  const commit = await git(origin, "rev-parse", "HEAD");
  await fs.writeFile(path.join(origin, "tracked.txt"), "later contents\n");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "--quiet",
    "-am",
    "later",
  );
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(home, "state", "node-host"),
    env: { PATH: process.env.PATH, HOME: home },
  });
  const identity = {
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    generation: 1,
  };
  const repository = createNodeWorkerRepositoryPreparation((command) =>
    runtime.exec({ ...identity, ...command, argv: [...command.argv] }),
  );
  const source = { origin: pathToFileURL(origin).href, commit };

  const prepared = await repository.prepareRepository(source);

  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") {
    throw new Error(prepared.reason);
  }
  const { remoteWorkspaceDir, manifestRef } = prepared.result;
  expect(prepared.seeded).toBe(false);
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
  expect(await fs.readFile(path.join(remoteWorkspaceDir, "tracked.txt"), "utf8")).toBe(
    "pinned contents\n",
  );
  const preparedWorkspace = {
    baseCommit: commit,
    workspaceDir: remoteWorkspaceDir,
    sourceManifestRef: manifestRef,
    preparedManifestRef: manifestRef,
  };
  const branch = "openclaw/session-prepared";
  await expect(
    repository.bindPreparedRepository(
      { ...source, branch },
      { ...preparedWorkspace, workspaceDir: origin },
    ),
  ).rejects.toThrow("session binding failed");
  expect(await git(remoteWorkspaceDir, "branch", "--show-current")).toBe("");
  await expect(
    repository.bindPreparedRepository(
      { ...source, origin: `${source.origin}-different`, branch },
      preparedWorkspace,
    ),
  ).rejects.toThrow("session binding failed");
  expect(await git(remoteWorkspaceDir, "branch", "--show-current")).toBe("");
  const author = { name: 'Prepared "Name"', email: "prepared+session@example.invalid" };
  const bound = await repository.bindPreparedRepository(
    { ...source, branch },
    preparedWorkspace,
    author,
  );
  expect(bound).toMatchObject({
    mode: "repository",
    baseCommit: commit,
    baseManifestRef: manifestRef,
    remoteWorkspaceDir,
  });
  expect(await git(remoteWorkspaceDir, "symbolic-ref", "--short", "HEAD")).toBe(branch);
  expect(await git(remoteWorkspaceDir, "config", "--local", "user.name")).toBe(author.name);
  expect(await git(remoteWorkspaceDir, "config", "--local", "user.email")).toBe(author.email);
  await fs.writeFile(path.join(remoteWorkspaceDir, "session-only.txt"), "discard on replacement");

  const offlineOrigin = `${origin}-offline`;
  await fs.rename(origin, offlineOrigin);
  try {
    // Bind replay cannot contact the source or erase edits in the already consumed workspace.
    await expect(
      repository.bindPreparedRepository({ ...source, branch }, preparedWorkspace),
    ).resolves.toEqual(bound);
    expect(await fs.readFile(path.join(remoteWorkspaceDir, "session-only.txt"), "utf8")).toBe(
      "discard on replacement",
    );
    await expect(
      repository.bindPreparedRepository(
        { ...source, branch: "openclaw/another-session" },
        preparedWorkspace,
      ),
    ).rejects.toThrow("session binding failed");
    await expect(
      repository.bindPreparedRepository(
        { ...source, commit: "f".repeat(40), branch },
        preparedWorkspace,
      ),
    ).rejects.toThrow("pinned session commit");
    const reused = await repository.prepareRepository(source, manifestRef);

    expect(reused).toEqual({ ...prepared, seeded: true });
    expect((await fs.readdir(remoteWorkspaceDir)).toSorted()).toEqual([".git", "tracked.txt"]);
    expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
    expect(await repository.captureManifest(remoteWorkspaceDir, commit, manifestRef)).toBe(
      manifestRef,
    );
  } finally {
    await fs.rename(offlineOrigin, origin);
  }

  // A provider can retain an exact commit after a force push removes its advertised ref.
  await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(origin, "checkout", "--orphan", "replacement");
  await git(origin, "rm", "--cached", "tracked.txt");
  await fs.writeFile(path.join(origin, "tracked.txt"), "rewritten history\n");
  await git(origin, "add", ".");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "replace history",
  );
  await git(origin, "update-ref", "-d", `refs/heads/${originalBranch}`);
  const replacement = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "replacement-node"),
    env: { PATH: process.env.PATH, HOME: path.join(root, "replacement-home") },
  });
  const replacementCommands: string[][] = [];
  const restored = await createNodeWorkerRepositoryPreparation((command) => {
    replacementCommands.push([...command.argv]);
    return replacement.exec({ ...identity, ...command, argv: [...command.argv] });
  }).prepareRepository(source, manifestRef);
  expect(restored.kind).toBe("prepared");
  if (restored.kind !== "prepared") {
    throw new Error(restored.reason);
  }
  expect(restored.seeded).toBe(false);
  expect(await git(restored.result.remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
  expect(replacementCommands).toContainEqual(
    expect.arrayContaining(["fetch", "--no-tags", "origin", commit]),
  );
});

it("refreshes a claimed prepared checkout to the selected ref without reseeding", async () => {
  const root = await fs.realpath(tempDirs.make("node-prepared-ref-refresh-"));
  const origin = path.join(root, "origin");
  await fs.mkdir(origin);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 10_000,
      baseEnv: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(origin, "init", "--quiet");
  await git(origin, "checkout", "-B", "main");
  await fs.writeFile(path.join(origin, "tracked.txt"), "old\n");
  await git(origin, "add", ".");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "old",
  );
  const oldCommit = await git(origin, "rev-parse", "HEAD");
  const commands: Array<{ seed: unknown; resetWorkspace: unknown }> = [];
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "node-state"),
    env: { PATH: process.env.PATH, HOME: path.join(root, "node-home") },
  });
  const repository = createNodeWorkerRepositoryPreparation((command) => {
    commands.push({ seed: command.seed, resetWorkspace: command.resetWorkspace });
    return runtime.exec({
      gatewayNamespace: "gateway-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      generation: 1,
      ...command,
      argv: [...command.argv],
    });
  });
  const url = pathToFileURL(origin).href;
  const prepared = await repository.prepareRepository({ origin: url, commit: oldCommit });
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") {
    throw new Error(prepared.reason);
  }
  const attested = {
    baseCommit: oldCommit,
    workspaceDir: prepared.result.remoteWorkspaceDir,
    sourceManifestRef: prepared.result.manifestRef,
    preparedManifestRef: prepared.result.manifestRef,
  };
  const branch = "clawson/prepared-test";
  const bound = await repository.bindPreparedRepository(
    { origin: url, commit: oldCommit, branch },
    attested,
  );
  const unchanged = await repository.refreshBoundPreparedRepository(
    { origin: url, ref: "main", branch },
    bound,
  );
  expect(unchanged).toEqual(bound);
  await fs.writeFile(path.join(origin, "tracked.txt"), "selected head\n");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-am",
    "new",
  );
  const selectedHead = await git(origin, "rev-parse", "HEAD");
  commands.length = 0;
  const refreshed = await repository.refreshBoundPreparedRepository(
    { origin: url, ref: "main", branch },
    bound,
  );
  expect(refreshed).toMatchObject({
    mode: "repository",
    baseCommit: selectedHead,
    remoteWorkspaceDir: attested.workspaceDir,
  });
  expect(refreshed.baseManifestRef).toBe(refreshed.manifestRef);
  expect(await git(attested.workspaceDir, "rev-parse", "HEAD")).toBe(selectedHead);
  expect(await git(attested.workspaceDir, "symbolic-ref", "--short", "HEAD")).toBe(branch);
  expect(await fs.readFile(path.join(attested.workspaceDir, "tracked.txt"), "utf8")).toBe(
    "selected head\n",
  );
  expect(
    commands.every((command) => command.seed === undefined && command.resetWorkspace === undefined),
  ).toBe(true);
  await expect(
    repository.bindPreparedRepository({ origin: url, commit: oldCommit, branch }, attested),
  ).rejects.toThrow("session binding failed");
  const rebound = await repository.bindPreparedRepository(
    { origin: url, commit: oldCommit, branch, allowRefRefresh: true },
    attested,
  );
  const offlineOrigin = `${origin}-offline`;
  await fs.rename(origin, offlineOrigin);
  const replay = await repository.refreshBoundPreparedRepository(
    { origin: url, commit: selectedHead, branch },
    rebound,
  );
  expect(replay.baseCommit).toBe(selectedHead);
  expect(await fs.readFile(path.join(attested.workspaceDir, "tracked.txt"), "utf8")).toBe(
    "selected head\n",
  );
  await fs.writeFile(path.join(attested.workspaceDir, "tracked.txt"), "authored session work\n");
  await git(attested.workspaceDir, "add", ".");
  await git(
    attested.workspaceDir,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "authored",
  );
  const authoredHead = await git(attested.workspaceDir, "rev-parse", "HEAD");
  await expect(
    repository.refreshBoundPreparedRepository(
      { origin: url, commit: selectedHead, branch },
      rebound,
    ),
  ).rejects.toThrow("changed after source selection");
  expect(await git(attested.workspaceDir, "rev-parse", "HEAD")).toBe(authoredHead);
});
