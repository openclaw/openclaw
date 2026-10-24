import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  assertGitHubPublicationRefCasCompleted,
  recoverGitHubPublicationBranchAndIndex,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  assertSafeGitPublicationWorkspace,
  captureGitHubPublicationWorkspaceSnapshot,
  githubPublicationPushArgs,
  githubPublicationUpdateRefArgs,
} from "./github-publication-git-transport.js";

let testState: OpenClawTestState;
let f: Awaited<ReturnType<typeof createFixture>>;
let directoryIndex = 0;
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const rejectRefUpdate = async () => {
  throw new Error("update-ref must not run");
};
const rejects = (operation: Promise<unknown>, message: string) =>
  expect(operation).rejects.toThrow(message);

beforeEach(async () => {
  testState = await createOpenClawTestState({
    prefix: "openclaw-publication-index-",
    env: { XDG_CONFIG_HOME: undefined },
  });
  directoryIndex = 0;
  f = await createFixture();
});

afterEach(async () => {
  await testState.cleanup();
});

async function makeDirectory(label: string): Promise<string> {
  const directory = testState.path(`${label}-${directoryIndex++}`);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function git(
  cwd: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await runCommandBuffered(["git", ...args], {
    cwd,
    env,
    ...(input === undefined ? {} : { input }),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8") || `git ${args[0]} failed`);
  }
  return result.stdout.toString("utf8").trim();
}

async function createFixture() {
  const cwd = await makeDirectory("git");
  const commit = (tree: string, parent: string, message: string) =>
    git(cwd, ["commit-tree", tree, "-p", parent], message);
  const run = (...args: string[]) => git(cwd, args);
  const write = (name: string, value: string) => fs.writeFile(path.join(cwd, name), value);
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", "OpenClaw Test"]);
  await git(cwd, ["config", "user.email", "openclaw@example.test"]);
  await write("artifact.txt", "base\n");
  await run("add", "artifact.txt");
  await run("commit", "-m", "base");
  const previousHead = await run("rev-parse", "HEAD");
  await write("artifact.txt", "accepted\n");
  await run("add", "artifact.txt");
  const sourceIndexTree = await run("write-tree");
  const headCommit = await commit(
    sourceIndexTree,
    previousHead,
    `published\n\nOpenClaw-Publication: ${REQUEST_ID}\n`,
  );
  const params = {
    cwd,
    previousHead,
    sourceIndexTree,
    workspaceTree: sourceIndexTree,
    headCommit,
    requestId: REQUEST_ID,
    branch: "main",
    env: process.env,
    assertCurrent: () => undefined,
    assertCustody: () => undefined,
    run: async (
      argv: string[],
      options?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
    ) => await git(cwd, argv.slice(1), options?.input, options?.env),
  };
  return {
    ...params,
    commit,
    git: run,
    write,
    file: (...parts: string[]) => path.join(cwd, ...parts),
    update: (
      overrides: Partial<Parameters<typeof updateGitHubPublicationBranchAndIndex>[0]> = {},
    ) => updateGitHubPublicationBranchAndIndex({ ...params, ...overrides }),
    recover: (
      overrides: Partial<Parameters<typeof recoverGitHubPublicationBranchAndIndex>[0]> = {},
    ) =>
      recoverGitHubPublicationBranchAndIndex({
        ...params,
        sourceHeadCommit: previousHead,
        ...overrides,
      }),
    state: async () => ({
      head: await run("rev-parse", "HEAD"),
      tree: await run("write-tree"),
      status: await run("status", "--porcelain"),
      artifact: await fs.readFile(path.join(cwd, "artifact.txt"), "utf8"),
    }),
  };
}

const moveHead = async () => {
  await f.git("update-ref", "refs/heads/main", f.headCommit, f.previousHead);
};

async function interruptAcceptedUpdate() {
  await rejects(
    f.update({
      updateRef: async () => {
        await moveHead();
        throw new Error("response lost");
      },
    }),
    "workspace recovery is pending",
  );
}

describe("GitHub publication index update", () => {
  it.each(["reset", "created"] as const)(
    "pins a conditional push when the remote branch was %s after admission",
    async (change) => {
      const remote = await makeDirectory("remote");
      await git(remote, ["init", "--bare", "--initial-branch=main"]);
      await fs.mkdir(f.file(".github/workflows"), { recursive: true });
      await f.write(
        ".github/workflows/example.yml",
        "name: synthetic\non: workflow_dispatch\njobs: {}\n",
      );
      await f.git("add", "-A");
      const workflowTree = await f.git("write-tree");
      const observedHead = await f.commit(workflowTree, f.previousHead, "maintainer workflow\n");
      await f.write("artifact.txt", "guest code\n");
      await f.git("add", "artifact.txt");
      const candidateTree = await f.git("write-tree");
      const candidate = await f.commit(candidateTree, observedHead, "guest code\n");
      await f.git("merge-base", "--is-ancestor", observedHead, candidate);
      if (change === "reset") {
        await f.git("push", remote, `${observedHead}:refs/heads/publication`);
        await git(remote, ["update-ref", "refs/heads/publication", f.previousHead]);
      } else {
        await f.git("push", remote, `${f.previousHead}:refs/heads/publication`);
      }
      const expectedHead = change === "reset" ? observedHead : "";
      const push = githubPublicationPushArgs(remote, candidate, "publication", expectedHead).slice(
        1,
      );
      await expect(git(f.cwd, push)).rejects.toThrow();
      expect(await git(remote, ["rev-parse", "refs/heads/publication"])).toBe(f.previousHead);
      if (expectedHead) {
        await git(remote, ["update-ref", "refs/heads/publication", expectedHead]);
      } else {
        await git(remote, ["update-ref", "-d", "refs/heads/publication"]);
      }
      await git(f.cwd, push);
      expect(await git(remote, ["rev-parse", "refs/heads/publication"])).toBe(candidate);
    },
  );

  it("publishes and recovers with worktree-scoped hooks without executing them", async () => {
    const remote = await makeDirectory("remote");
    const hooks = await makeDirectory("hooks");
    const marker = path.join(hooks, "invoked");
    const hookEnv = { ...process.env, OPENCLAW_PUBLICATION_HOOK_MARKER: marker };
    const run = (argv: string[]) => f.run(argv, { env: hookEnv });
    await git(remote, ["init", "--bare"]);
    for (const hook of ["pre-push", "post-index-change", "reference-transaction"]) {
      await fs.writeFile(
        path.join(hooks, hook),
        '#!/bin/sh\nprintf invoked > "$OPENCLAW_PUBLICATION_HOOK_MARKER"\nexit 97\n',
        { mode: 0o755 },
      );
    }
    await f.git("config", "--local", "extensions.worktreeConfig", "true");
    await f.git("config", "--worktree", "core.hooksPath", hooks);

    await expect(
      assertSafeGitPublicationWorkspace(
        f.cwd,
        async (argv, options) =>
          await runCommandBuffered(argv, {
            ...options,
            cwd: options?.cwd ?? f.cwd,
            timeoutMs: 10_000,
            maxOutputBytes: 64 * 1024,
          }),
      ),
    ).resolves.toBeUndefined();

    await rejects(
      f.update({
        env: hookEnv,
        updateRef: async () => {
          await run(githubPublicationUpdateRefArgs("main", f.headCommit, f.previousHead));
          throw new Error("response lost");
        },
      }),
      "workspace recovery is pending",
    );
    await fs.rm(f.file(".git", "index.lock"));
    const hardenedGit = ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];
    await run([...hardenedGit, "update-index", "--force-remove", "artifact.txt"]);
    await run([...hardenedGit, "add", "artifact.txt"]);
    await f.recover({
      run: async (argv, options) =>
        await git(f.cwd, argv.slice(1), options?.input, options?.env ?? hookEnv),
    });
    await expect(fs.access(marker)).rejects.toThrow();
    await run(githubPublicationPushArgs(remote, f.headCommit, "publication", ""));

    expect(await git(remote, ["rev-parse", "refs/heads/publication"])).toBe(f.headCommit);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("rejects a filter from Git's default global attributes file", async () => {
    const globalAttributes = path.join(testState.home, ".config", "git", "attributes");
    await fs.mkdir(path.dirname(globalAttributes), { recursive: true });
    await fs.writeFile(globalAttributes, "*.secret filter=redact\n");

    await rejects(captureGitHubPublicationWorkspaceSnapshot(f), "unsupported Git clean filter");
  });

  it("settles the accepted branch and index after publication authority ends", async () => {
    let current = true;
    await f.update({
      assertCurrent: () => {
        if (!current) {
          throw new Error("publication permission ended");
        }
      },
      updateRef: async () => {
        await moveHead();
        current = false;
      },
    });

    expect(await f.state()).toEqual({
      head: f.headCommit,
      tree: f.workspaceTree,
      status: "",
      artifact: "accepted\n",
    });
    expect(
      (await fs.readdir(f.file(".git"))).filter(
        (entry) => entry === "index.lock" || entry.startsWith("index.openclaw-"),
      ),
    ).toEqual([]);
  });

  it("rejects concurrent staged changes without moving HEAD or rewriting the index", async () => {
    await f.write("concurrent.txt", "keep staged\n");
    await f.git("add", "concurrent.txt");

    await rejects(f.update({ updateRef: rejectRefUpdate }), "workspace index changed");

    expect(await f.git("rev-parse", "HEAD")).toBe(f.previousHead);
    expect(await f.git("diff", "--cached", "--name-only")).toContain("concurrent.txt");
  });

  it.each([false, true])(
    "recovers the retained index when ambiguous CAS moved=%s",
    async (moved) => {
      const indexPath = f.file(".git", "index");
      const indexBefore = await fs.readFile(indexPath);
      await rejects(
        f.update({
          updateRef: async () => {
            if (moved) {
              await moveHead();
            }
            throw new Error("response lost");
          },
        }),
        "workspace recovery is pending",
      );
      expect(await f.git("rev-parse", "HEAD")).toBe(moved ? f.headCommit : f.previousHead);
      if (!moved) {
        expect(await fs.readFile(indexPath)).toEqual(indexBefore);
        expect((await fs.stat(f.file(".git", "index.lock"))).size).toBeGreaterThan(0);
        await f.update({ updateRef: moveHead });
      } else {
        await f.recover();
        expect(await f.git("write-tree")).toBe(f.workspaceTree);
        await expect(fs.stat(f.file(".git", "index.lock"))).rejects.toThrow();
      }
      expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await f.git("status", "--porcelain")).toBe("");
    },
  );

  it("does not install a recovered index after custody changes during Git probes", async () => {
    await interruptAcceptedUpdate();

    let current = true;
    await rejects(
      f.recover({
        assertCustody: () => {
          if (!current) {
            throw new Error("publication authority changed");
          }
        },
        run: async (argv, options) => {
          const result = await git(f.cwd, argv.slice(1), options?.input, options?.env);
          if (argv[1] === "show") {
            current = false;
          }
          return result;
        },
      }),
      "publication authority changed",
    );
    await expect(fs.stat(f.file(".git", "index.lock"))).resolves.toBeDefined();
  });

  it("does not claim another Git operation's byte-identical index lock", async () => {
    const foreignIndex = f.file("foreign-index");
    await git(f.cwd, ["read-tree", f.headCommit], undefined, {
      ...process.env,
      GIT_INDEX_FILE: foreignIndex,
    });
    await fs.rename(foreignIndex, f.file(".git", "index.lock"));

    await rejects(f.update({ updateRef: rejectRefUpdate }), "locked by another operation");

    expect(await f.git("rev-parse", "HEAD")).toBe(f.previousHead);
    expect((await fs.stat(f.file(".git", "index.lock"))).size).toBeGreaterThan(0);
  });

  it.each([false, true])(
    "settles a definite ref CAS rejection (custody revoked: %s)",
    async (revoked) => {
      let current = true;
      await rejects(
        f.update({
          assertCustody() {
            if (!current) {
              throw new Error("Publication custody revoked");
            }
          },
          updateRef: async () => {
            const result = await runCommandBuffered(
              ["git", "update-ref", "refs/heads/main", f.headCommit, "f".repeat(40)],
              { cwd: f.cwd },
            );
            current = !revoked;
            assertGitHubPublicationRefCasCompleted(result);
          },
        }),
        "workspace branch changed before commit",
      );

      if (revoked) {
        await expect(fs.stat(f.file(".git", "index.lock"))).resolves.toBeDefined();
      } else {
        await expect(fs.stat(f.file(".git", "index.lock"))).rejects.toThrow();
      }
      const recoveries = (await fs.readdir(f.file(".git"))).filter((name) =>
        name.startsWith("index.openclaw-"),
      );
      expect(recoveries).toHaveLength(revoked ? 1 : 0);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.previousHead);
    },
  );
});
