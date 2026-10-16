import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, assert, expect, it, vi } from "vitest";
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
const ORIGIN = "https://example.invalid/repository.git";
const success = {
  code: 0,
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
  workspaceDir: FIXTURE_WORKSPACE,
};

it.each(["win32", "linux", "darwin"] as const)(
  "preserves authenticated Git arguments with native long paths on %s",
  async (platform) => {
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
          platform === "win32" ? ["-c", "core.longpaths=true", ...gitArgs] : gitArgs,
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
              GIT_CONFIG_KEY_0: `http.${ORIGIN}.extraheader`,
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${FIXTURE_TOKEN}`).toString("base64")}`,
            },
          },
        );
      }
      return { ...success, stdout: "absent", code: seed ? 0 : 1 };
    });
    await expect(
      repository.prepareRepository({ origin: ORIGIN, gitToken: FIXTURE_TOKEN }),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "clone-failed",
    });
  },
);

it.each<[string, Partial<SpawnResult & { workspaceDir: string }>, string]>([
  [
    "clone",
    {
      code: 128,
      stderr: `fatal: authentication failed ${FIXTURE_TOKEN}\n${"progress ".repeat(300)}check repository access`,
    },
    "check repository access",
  ],
  [
    "fetch",
    { code: null, stderr: " \n", termination: "timeout", signal: "SIGTERM" },
    "timeout (exit code null, signal SIGTERM): no stderr output",
  ],
  ["rev-parse", { code: 128, stderr: "missing FETCH_HEAD" }, "missing FETCH_HEAD"],
  ["--detach", { code: 1, stderr: "Permission denied" }, "Permission denied"],
  ["-B", { code: 128, stderr: "fatal: cannot lock ref" }, "cannot lock ref"],
  ["rev-parse", { stdout: "not a commit" }, "invalid commit revision"],
  ["rev-parse", { stdout: "b".repeat(40) }, "requested commit mismatch"],
  [
    "--detach",
    { workspaceDir: "/node/other-workspace" },
    "workspace directory changed during checkout",
  ],
])("preserves bounded, redacted %s failure details (case %#)", async (stage, result, diagnosis) => {
  const exec: NodeWorkerRepositoryExec = async ({ argv, seed }) => ({
    ...success,
    stdout: seed
      ? "absent"
      : argv.includes("rev-parse")
        ? FIXTURE_COMMIT
        : `sha256:${"c".repeat(64)}`,
    ...(argv.includes(stage) ? result : {}),
  });
  const prepared = await createNodeWorkerRepositoryPreparation(exec).prepareRepository({
    origin: ORIGIN,
    commit: FIXTURE_COMMIT,
    branch: "openclaw/session",
  });

  expect(prepared).toMatchObject({
    kind: "failed",
    reason: stage === "clone" ? "clone-failed" : "checkout-failed",
  });
  assert(prepared.kind === "failed");
  const label = `git ${stage.startsWith("-") ? "checkout " : ""}${stage}`;
  expect(prepared.detail).toContain(
    `${label}: ${result.termination ?? "exit"} (exit code ${result.code === undefined ? 0 : result.code}, signal ${result.signal ?? null})`,
  );
  expect(prepared.detail).toContain(diagnosis);
  expect(prepared.detail).not.toContain(FIXTURE_TOKEN);
  expect(prepared.detail).not.toContain("\n");
  expect(prepared.detail!.length).toBeLessThanOrEqual(1_024);
});

it("reports missing Git from the executable repository helper", async () => {
  const root = await fs.realpath(tempDirs.make("node-repository-missing-git-"));
  const repository = createNodeWorkerRepositoryPreparation(async ({ argv, input, seed }) => {
    if (seed) {
      return { ...success, stdout: "absent", workspaceDir: root };
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

  await expect(repository.prepareRepository({ origin: ORIGIN })).resolves.toMatchObject({
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
  const commitAtOrigin = (...args: string[]) => git(origin, "commit", "--quiet", ...args);
  await git(origin, "init", "--quiet");
  await git(origin, "config", "user.name", "Repository Test");
  await git(origin, "config", "user.email", "repository@example.invalid");
  const originalBranch = await git(origin, "symbolic-ref", "--short", "HEAD");
  await fs.writeFile(path.join(origin, "tracked.txt"), "pinned contents\n");
  await git(origin, "add", ".");
  await commitAtOrigin("-m", "pinned");
  const commit = await git(origin, "rev-parse", "HEAD");
  await fs.writeFile(path.join(origin, "tracked.txt"), "later contents\n");
  await commitAtOrigin("-am", "later");
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

  assert(prepared.kind === "prepared", JSON.stringify(prepared));
  const { remoteWorkspaceDir, manifestRef } = prepared.result;
  const checkoutGit = (...args: string[]) => git(remoteWorkspaceDir, ...args);
  const read = (name: string) => fs.readFile(path.join(remoteWorkspaceDir, name), "utf8");
  expect(prepared.seeded).toBe(false);
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(await checkoutGit("rev-parse", "HEAD")).toBe(commit);
  expect(await read("tracked.txt")).toBe("pinned contents\n");
  const preparedWorkspace = {
    baseCommit: commit,
    workspaceDir: remoteWorkspaceDir,
    sourceManifestRef: manifestRef,
    preparedManifestRef: manifestRef,
  };
  const branch = "openclaw/session-prepared";
  const binding = { ...source, branch };
  const bind = (sourceIdentity = binding, workspace = preparedWorkspace) =>
    repository.bindPreparedRepository(sourceIdentity, workspace);
  for (const [sourceIdentity, workspace] of [
    [binding, { ...preparedWorkspace, workspaceDir: origin }],
    [{ ...binding, origin: `${source.origin}-different` }, preparedWorkspace],
  ] as const) {
    await expect(bind(sourceIdentity, workspace)).rejects.toThrow("session binding failed");
    expect(await checkoutGit("branch", "--show-current")).toBe("");
  }
  const author = { name: 'Prepared "Name"', email: "prepared+session@example.invalid" };
  const bound = await repository.bindPreparedRepository(binding, preparedWorkspace, author);
  expect(bound).toMatchObject({
    mode: "repository",
    baseCommit: commit,
    baseManifestRef: manifestRef,
    remoteWorkspaceDir,
  });
  expect(
    await Promise.all([
      checkoutGit("symbolic-ref", "--short", "HEAD"),
      checkoutGit("config", "--local", "user.name"),
      checkoutGit("config", "--local", "user.email"),
    ]),
  ).toEqual([branch, author.name, author.email]);
  await fs.writeFile(path.join(remoteWorkspaceDir, "session-only.txt"), "discard on replacement");

  const offlineOrigin = `${origin}-offline`;
  await fs.rename(origin, offlineOrigin);
  try {
    // Bind replay cannot contact the source or erase edits in the already consumed workspace.
    await expect(bind()).resolves.toEqual(bound);
    expect(await read("session-only.txt")).toBe("discard on replacement");
    await expect(bind({ ...binding, branch: "openclaw/another-session" })).rejects.toThrow(
      "session binding failed",
    );
    await expect(bind({ ...binding, commit: "f".repeat(40) })).rejects.toThrow(
      "pinned session commit",
    );
    const reused = await repository.prepareRepository(source, manifestRef);

    expect(reused).toEqual({ ...prepared, seeded: true });
    expect((await fs.readdir(remoteWorkspaceDir)).toSorted()).toEqual([".git", "tracked.txt"]);
    expect(await checkoutGit("rev-parse", "HEAD")).toBe(commit);
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
  await commitAtOrigin("-m", "replace history");
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
  assert(restored.kind === "prepared", JSON.stringify(restored));
  expect(restored.seeded).toBe(false);
  expect(await git(restored.result.remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
  expect(replacementCommands).toContainEqual(
    expect.arrayContaining(["fetch", "--no-tags", "origin", commit]),
  );
});
