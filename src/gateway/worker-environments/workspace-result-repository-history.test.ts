import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { MAX_WORKSPACE_RESULT_GIT_PACK_BYTES } from "../../worker/node-workspace-transfer-protocol.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import * as checkpoints from "./session-repository-checkpoints.js";
import { sessionTarget } from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit as git } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Local Git origins must not inherit the operator's GitHub login.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));

const { fixture } = useRepositoryWorkspaceResultFixture();

it.each(["restart", "fork"] as const)(
  "restores worker commits and dirty files after repository-session reclaim (%s)",
  async (mode) => {
    const f = await fixture("worker-turn");
    await f.write("hello.txt", "committed\n");
    await git(f.remote, ["add", "hello.txt"]);
    await git(f.remote, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "worker commit",
    ]);
    const head = await git(f.remote, ["rev-parse", "HEAD"]);
    await f.write("hello.txt", "committed\ndirty\n");
    await f.stop(sessionTarget);
    const original = (await f.store.get(f.repository.workspaceId))!;
    const repository =
      mode === "fork"
        ? await checkpoints.forkSessionRepositoryWorkspace({
            sourceWorkspaceId: original.workspaceId,
            agentId: sessionTarget.agentId,
            sessionKey: `${sessionTarget.sessionKey}-fork`,
            assertCurrent: () => {},
          })
        : original;
    const artifacts = f.store.artifactPath(repository.workspaceId);
    await expect(git(artifacts, ["cat-file", "-t", head])).rejects.toThrow();
    await expect(git(artifacts, ["cat-file", "-t", repository.baseCommit!])).rejects.toThrow();
    await git(artifacts, ["gc", "--prune=now", "--quiet"]);
    await fs.rm(f.remote, { recursive: true });
    const restored = await syncSessionRepositoryWorkspace({
      ...sessionTarget,
      repository,
      tunnel: f.tunnel,
      generation: 2,
      assertCurrent: () => {},
    });
    expect(await git(restored.remoteWorkspaceDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(restored.remoteWorkspaceDir, ["show", "HEAD:hello.txt"])).toBe("committed");
    expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "hello.txt"), "utf8")).toBe(
      "committed\ndirty\n",
    );
    expect(await git(restored.remoteWorkspaceDir, ["diff", "--cached", "--name-only"])).toBe("");
  },
);

it.each(["non-descending", "oversized", "missing", "unavailable"] as const)(
  "keeps files and reports %s repository Git history at reclaim",
  async (kind) => {
    const f = await fixture("worker-turn");
    if (kind === "non-descending") {
      await git(f.remote, ["checkout", "--orphan", "rewritten"]);
    }
    await f.write("hello.txt", "retained despite history failure\n");
    await git(f.remote, ["add", "hello.txt"]);
    await git(f.remote, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "worker commit",
    ]);
    const stage = checkpoints.stageSessionRepositoryCheckpoint;
    const takeUpload = f.workspaceTransfer.takeUpload.bind(f.workspaceTransfer);
    const upload =
      kind === "unavailable"
        ? vi.spyOn(f.workspaceTransfer, "takeUpload").mockImplementation((...args) => {
            const result = takeUpload(...args);
            return result.gitHistory
              ? {
                  ...result,
                  gitHistory: {
                    ...result.gitHistory,
                    headCommit: result.gitHistory.baseCommit,
                    descendsFromBase: false,
                    unavailableReason: "worker Git capture failed",
                  },
                }
              : result;
          })
        : undefined;
    let oversized: string | undefined;
    if (kind === "oversized") {
      oversized = path.join(path.dirname(f.remote), "oversized.pack");
      const pack = await fs.open(oversized, "wx");
      await pack.truncate(MAX_WORKSPACE_RESULT_GIT_PACK_BYTES + 1);
      await pack.close();
    }
    const capture = vi
      .spyOn(checkpoints, "stageSessionRepositoryCheckpoint")
      .mockImplementation((params) =>
        stage(
          kind === "oversized"
            ? { ...params, gitPackPath: oversized }
            : kind === "missing"
              ? { ...params, gitHistory: undefined, gitPackPath: undefined }
              : params,
        ),
      );
    try {
      await f.stop(sessionTarget);
    } finally {
      capture.mockRestore();
      upload?.mockRestore();
      if (oversized) {
        await fs.rm(oversized);
      }
    }
    expect(f.notes).toEqual([expect.stringMatching(/^Cloud worker commits were not adopted:/u)]);
    expect(f.notes[0]).toContain(
      kind === "non-descending"
        ? "does not descend"
        : kind === "oversized"
          ? "byte limit"
          : kind === "missing"
            ? "did not provide"
            : "worker Git capture failed",
    );
    await checkpoints.withSessionRepositoryCheckpoint(
      { workspaceId: f.repository.workspaceId },
      async (snapshot) => {
        expect(await fs.readFile(path.join(snapshot.stagingRoot, "hello.txt"), "utf8")).toBe(
          "retained despite history failure\n",
        );
      },
    );
  },
);
