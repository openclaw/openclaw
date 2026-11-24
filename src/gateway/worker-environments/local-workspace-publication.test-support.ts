import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi, type Mock } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { withDiagnosticsTimelineObserver } from "../../infra/diagnostics-timeline.js";
import * as exec from "../../process/exec.js";
import { prepareLocalWorkspaceArchiveFixture } from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

export async function provePublicationPauseAttribution(
  owner: LocalWorkspaceOwner,
  checkpointLog: Mock<(message: string) => void>,
) {
  await prepareLocalWorkspaceArchiveFixture(owner);
  await requireGit(owner.worktree.repoRoot, ["config", "--unset-all", "credential.helper"]);
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await fs.writeFile(path.join(projection, "source.txt"), "publication edit\n");
  const registry = await import("../../agents/sandbox/registry.js");
  const engine = await import("../../agents/sandbox/container-engine.js");
  const worker = await import("./workspace-manifest-worker.js");
  const { captureGitHubPublicationWorkspaceSnapshot } =
    await import("../github-publication-git-transport.js");
  vi.stubEnv("DOCKER_HOST", "unix:///synthetic/publication-docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  let paused = false;
  vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    if (args[0] === "pause") {
      paused = true;
    } else if (args[0] === "unpause") {
      paused = false;
    }
    return {
      code: 0,
      stderr: "",
      stdout: args[0] === "inspect" ? `${"a".repeat(64)} true ${paused}` : "",
    };
  });
  await registry.updateRegistry({
    containerName: "publication-fixture",
    backendId: "docker",
    sessionKey: owner.sessionKey,
    workspaceDir: projection,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "fixture",
  });
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const stage = worker.prepareWorkspaceStageInput;
  vi.spyOn(worker, "prepareWorkspaceStageInput").mockImplementation(async (...args) => {
    expect(paused).toBe(true);
    elapsed += 2_500;
    return stage(...args);
  });
  const command = exec.runCommandBuffered;
  let staged = 0;
  vi.spyOn(exec, "runCommandBuffered").mockImplementation(async (argv, options) => {
    if (argv[0] === "git" && argv.includes("add")) {
      expect(paused, "Canonical Git staging must not freeze the guest").toBe(false);
      if (staged++ === 0) {
        await fs.writeFile(path.join(projection, "source.txt"), "later guest edit\n");
        await fs.writeFile(path.join(projection, "later.txt"), "later guest file\n");
      }
      elapsed += 10_000;
    }
    return command(argv, options);
  });
  const spans: Record<string, number> = {};
  const snapshot = await withDiagnosticsTimelineObserver(
    (name) => {
      const started = performance.now();
      return () => {
        spans[name] = (spans[name] ?? 0) + performance.now() - started;
      };
    },
    () => captureGitHubPublicationWorkspaceSnapshot({ cwd: owner.worktree.path }),
  );
  expect(paused).toBe(false);
  expect(
    await requireGit(owner.worktree.repoRoot, ["show", `${snapshot.workspaceTree}:source.txt`]),
  ).toBe("publication edit");
  expect(
    await requireGit(owner.worktree.repoRoot, ["ls-tree", snapshot.workspaceTree, "later.txt"]),
  ).toBe("");
  const release = checkpointLog.mock.calls
    .map(([message]) => message)
    .find((message) => message.startsWith("Local workspace unpause: reason=publication"));
  expect(release).toContain('phaseDurationsMs={"staging":2500}');
  expect(spans["attempt.setup.sandbox.workspace_selection.projection.staging"]).toBe(2_500);
  expect(
    spans["attempt.setup.sandbox.workspace_selection.projection.operation.snapshotStage"],
  ).toBe(10_000);
  expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe("later guest edit\n");
  const next = await captureGitHubPublicationWorkspaceSnapshot({ cwd: owner.worktree.path });
  expect(
    await requireGit(owner.worktree.repoRoot, ["show", `${next.workspaceTree}:source.txt`]),
  ).toBe("later guest edit");
  expect(
    await requireGit(owner.worktree.repoRoot, ["show", `${next.workspaceTree}:later.txt`]),
  ).toBe("later guest file");
}
