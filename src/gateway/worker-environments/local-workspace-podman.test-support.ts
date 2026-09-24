import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { localWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);

/** Production required-Podman lifecycle proof, including revocation and selected cwd. */
export async function proveRequiredPodmanWorkspace(root: string, owner: LocalWorkspaceOwner) {
  const [
    { insertRegistryWorktree },
    { upsertSessionEntryCore },
    { resolveSandboxContext },
    { removeSandboxContainer },
    { readRegistry },
    { runCommandWithTimeout },
  ] = await Promise.all([
    import("../../agents/worktrees/registry.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../agents/sandbox/context.js"),
    import("../../agents/sandbox/manage.js"),
    import("../../agents/sandbox/registry.js"),
    import("../../process/exec.js"),
  ]);
  const engineHome = process.env.OPENCLAW_TEST_PODMAN_HOME;
  const engineRuntime = process.env.OPENCLAW_TEST_PODMAN_RUNTIME_DIR;
  if (!engineHome || !engineRuntime) {
    throw new Error("Real Podman proof requires explicit engine HOME and runtime directory");
  }
  vi.stubEnv("HOME", engineHome);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(engineHome, ".config"));
  vi.stubEnv("XDG_DATA_HOME", path.join(engineHome, ".local", "share"));
  vi.stubEnv("XDG_RUNTIME_DIR", engineRuntime);
  const { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } =
    await import("../../agents/worktrees/service.js");
  const { captureGitHubPublicationWorkspaceSnapshot } =
    await import("../github-publication-git-transport.js");
  let now = Date.now();
  const service = new ManagedWorktreeService({ now: () => now });
  owner.worktree.repoFingerprint = (
    await service.resolveRepositoryIdentity(owner.worktree.path)
  ).fingerprint;
  insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [] });
  await upsertSessionEntryCore(
    { agentId: owner.agentId, sessionKey: owner.sessionKey },
    {
      sessionId: owner.sessionId,
      updatedAt: Date.now(),
      sandbox: "required",
      spawnedCwd: owner.worktree.path,
      sessionRoot: owner.worktree.path,
      worktree: {
        id: owner.worktree.id,
        branch: owner.worktree.branch,
        repoRoot: owner.worktree.repoRoot,
        canonicalWorkspaceDir: owner.worktree.repoRoot,
      },
    },
  );
  const workspace = path.join(root, "agent");
  await fs.mkdir(workspace);
  const config: import("../../config/types.openclaw.js").OpenClawConfig = {
    agents: {
      entries: { main: { workspace } },
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "off",
          backend: "podman",
          scope: "session",
          workspaceAccess: "none",
          prune: { idleHours: 0, maxAgeDays: 0 },
          docker: { image: "localhost/openclaw-sandbox:bookworm-slim", network: "none" },
        },
      },
    },
  };
  try {
    const engine = await import("../../agents/sandbox/container-engine.js");
    const execute = engine.execContainer;
    let allocationCurrent = true;
    const effects: string[] = [];
    const observe = vi
      .spyOn(engine, "execContainer")
      .mockImplementation(async (target, args, options) => {
        const result = await execute(target, args, options);
        if (args[0] === "image" && args[1] === "inspect") {
          allocationCurrent = false;
        }
        if (["create", "start", "exec"].includes(args[0]!)) {
          effects.push(args[0]!);
        }
        return result;
      });
    try {
      await expect(
        resolveSandboxContext({
          config,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          workspaceDir: owner.worktree.path,
          assertCurrent: () => {
            if (!allocationCurrent) {
              throw new Error("allocation revoked");
            }
          },
        }),
      ).rejects.toThrow("allocation revoked");
      expect(effects).toEqual([]);
    } finally {
      observe.mockRestore();
    }
    let fileAuthority = true;
    const sandbox = await resolveSandboxContext({
      config,
      assertCurrent: () => {
        if (!fileAuthority) {
          throw new Error("filesystem owner revoked");
        }
      },
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      workspaceDir: owner.worktree.path,
    });
    expect(sandbox?.required).toBe(true);
    expect(sandbox?.workspaceAccess).toBe("rw");
    if (!sandbox?.backend || !sandbox.fsBridge) {
      throw new Error("Sandbox was not prepared");
    }
    // Reconciliation may lose its owner after pausing. Only a fresh live owner
    // can release the retained exact runtime generation.
    const { withLocalWorkspaceProjection } = await import("./local-workspace-projection.js");
    const { bindPodmanSandboxEngine } = await import("../../agents/sandbox/docker.js");
    const runtimeEntry = (await readRegistry()).entries.find(
      (row) => row.containerName === sandbox.containerName,
    );
    if (!runtimeEntry?.backendTarget) {
      throw new Error("Podman target was not retained");
    }
    const runtimeEngine = bindPodmanSandboxEngine(runtimeEntry.backendTarget);
    let reconciliationCurrent = true;
    await expect(
      withLocalWorkspaceProjection(
        {
          ...owner,
          assertCurrent: () => {
            owner.assertCurrent();
            if (!reconciliationCurrent) {
              throw new Error("reconciliation revoked");
            }
          },
        },
        async () => {
          reconciliationCurrent = false;
        },
      ),
    ).rejects.toThrow("reconciliation revoked");
    const pausedState = () =>
      execute(runtimeEngine, ["inspect", "-f", "{{.State.Paused}}", sandbox.containerName]);
    expect((await pausedState()).stdout.trim()).toBe("true");
    expect(localWorkspaceStore().get(owner.worktree.id)?.paused_runtimes_json).toContain(
      sandbox.containerName,
    );
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect((await pausedState()).stdout.trim()).toBe("false");
    expect(localWorkspaceStore().get(owner.worktree.id)?.paused_runtimes_json).toBeNull();
    const skillScaffold = path.join(sandbox.workspaceDir, ".openclaw/sandbox-skills/skills");
    expect((await fs.stat(skillScaffold)).uid).toBe((await fs.stat(sandbox.workspaceDir)).uid);
    await sandbox.fsBridge.writeFile({ filePath: "source.txt", data: "real sandbox edit\n" });
    await sandbox.fsBridge.writeFile({
      filePath: ".gitignore",
      data: ".env.local\nguest-ignored/\n",
    });
    await sandbox.fsBridge.writeFile({
      filePath: "guest-ignored/data",
      data: "real ignored guest bytes\n",
    });
    await sandbox.fsBridge.writeFile({
      filePath: ".openclaw/project.json",
      data: "valid project content\n",
    });
    await expect(
      sandbox.fsBridge.writeFile({
        filePath: ".openclaw/sandbox-skills/skills/forbidden",
        data: "must not write",
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "real sandbox edit\n",
    );
    const spec = await sandbox.backend.buildExecSpec({
      command:
        'git status --porcelain && test ! -e .env.local && test -z "$GH_TOKEN$GITHUB_TOKEN" && ! touch .openclaw/sandbox-skills/skills/.write-probe',
      usePty: false,
      env: {},
    });
    const result = await runCommandWithTimeout(spec.argv, {
      baseEnv: spec.env,
      timeoutMs: 30000,
    });
    await sandbox.backend.finalizeExec?.({
      status: result.code === 0 ? "completed" : "failed",
      exitCode: result.code,
      timedOut: false,
      token: spec.finalizeToken,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("source.txt");
    const runShell = sandbox.backend.runShellCommand.bind(sandbox.backend);
    sandbox.backend.runShellCommand = async (command) => {
      const probeResult = await runShell(command);
      if (command.stdin === undefined) {
        fileAuthority = false;
      }
      return probeResult;
    };
    await expect(
      sandbox.fsBridge.writeFile({ filePath: "revoked-write.txt", data: "must not write" }),
    ).rejects.toThrow("filesystem owner revoked");
    await expect(
      fs.stat(path.join(sandbox.workspaceDir, "revoked-write.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(owner.worktree.path, "revoked-write.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    sandbox.backend.runShellCommand = runShell;
    const resumed = await resolveSandboxContext({
      config,
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      workspaceDir: owner.worktree.path,
    });
    expect(resumed?.workspaceDir).toBe(sandbox.workspaceDir);
    expect((await resumed!.fsBridge!.readFile({ filePath: "source.txt" })).toString()).toBe(
      "real sandbox edit\n",
    );
    expect(await fs.readFile(path.join(owner.worktree.repoRoot, "source.txt"), "utf8")).toBe(
      "original\n",
    );
    // A selected subdirectory changes execution cwd, not the projection/mount owner.
    const selected = path.join(owner.worktree.path, "packages", "app");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, "selected.txt"), "selected source\n");
    await git(owner.worktree.path, "add", "packages/app/selected.txt");
    const { resolveAttemptWorkspaceSandbox } = await import("../../agents/workspace-sandbox.js");
    const mapped = await resolveAttemptWorkspaceSandbox({
      config,
      agentId: owner.agentId,
      sessionId: owner.sessionId,
      sessionKey: owner.sessionKey,
      workspaceDir: selected,
      cwd: selected,
      sessionRoot: owner.worktree.path,
    });
    expect(mapped.effectiveCwd).toBe(path.join(sandbox.workspaceDir, "packages", "app"));
    expect(mapped.sessionPermissionRoot).toBe(sandbox.workspaceDir);
    await mapped.sandbox!.fsBridge!.writeFile({
      filePath: "relative.txt",
      cwd: mapped.effectiveCwd,
      data: "selected write\n",
    });
    expect(await fs.readFile(path.join(selected, "relative.txt"), "utf8")).toBe("selected write\n");
    await expect(fs.stat(path.join(owner.worktree.path, "relative.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const selectedSpec = await mapped.sandbox!.backend!.buildExecSpec({
      command: "pwd; cat selected.txt",
      env: {},
      usePty: false,
      workdir: mapped.sandbox!.fsBridge!.resolvePath({
        filePath: ".",
        cwd: mapped.effectiveCwd,
      }).containerPath,
    });
    const selectedResult = await runCommandWithTimeout(selectedSpec.argv, {
      baseEnv: selectedSpec.env,
      timeoutMs: 30000,
    });
    await mapped.sandbox!.backend!.finalizeExec?.({
      status: "completed",
      exitCode: selectedResult.code,
      timedOut: false,
      token: selectedSpec.finalizeToken,
    });
    expect(selectedResult.code).toBe(0);
    expect(selectedResult.stdout).toContain("/packages/app\nselected source");

    // Termination custody survives revocation, but cannot admit another writer.
    let childCurrent = true;
    const childSandbox = await resolveSandboxContext({
      config,
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      workspaceDir: owner.worktree.path,
      assertCurrent: () => {
        if (!childCurrent) {
          throw new Error("child owner revoked");
        }
      },
    });
    const backend = childSandbox!.backend!;
    const { prepareSandboxProcessCleanup } =
      await import("../../agents/sandbox/process-cleanup.js");
    const cleanup = prepareSandboxProcessCleanup(backend, {});
    const childSpec = await backend.buildExecSpec({
      command: "while :; do echo tick >> child-writes; sleep 0.1; done",
      env: cleanup.env,
      usePty: false,
    });
    childSpec.assertCurrent?.();
    const child = spawn(childSpec.argv[0]!, childSpec.argv.slice(1), {
      env: childSpec.env,
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    try {
      await vi.waitFor(async () =>
        expect(
          (await fs.stat(path.join(childSandbox!.workspaceDir, "child-writes"))).size,
        ).toBeGreaterThan(0),
      );
      childCurrent = false;
      expect(() => prepareSandboxProcessCleanup(backend, {})).toThrow("child owner revoked");
      await expect(
        backend.runShellCommand({ script: "touch forbidden-child-write" }),
      ).rejects.toThrow("child owner revoked");
      await expect(cleanup.interrupt(1000)).rejects.toThrow("child owner revoked");
      await cleanup.terminate();
      await closed;
      const stoppedBytes = await fs.readFile(path.join(childSandbox!.workspaceDir, "child-writes"));
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(await fs.readFile(path.join(childSandbox!.workspaceDir, "child-writes"))).toEqual(
        stoppedBytes,
      );
      await expect(
        backend.finalizeExec?.({
          status: "failed",
          exitCode: child.exitCode,
          timedOut: false,
          token: childSpec.finalizeToken,
        }),
      ).rejects.toThrow("child owner revoked");
    } finally {
      await cleanup.terminate();
      child.kill("SIGKILL");
      await closed;
    }
    // The source-only fixture deliberately installed an unsafe host helper.
    // Publication must reject it, then succeed only after the fixture owner removes it.
    await expect(
      captureGitHubPublicationWorkspaceSnapshot({ cwd: owner.worktree.path }),
    ).rejects.toThrow("unsupported Git transport");
    await git(owner.worktree.repoRoot, "config", "--unset-all", "credential.helper");
    const published = await captureGitHubPublicationWorkspaceSnapshot({
      cwd: owner.worktree.path,
      assertCurrent: owner.assertCurrent,
    });
    const publishedPaths = await git(
      owner.worktree.path,
      "ls-tree",
      "-r",
      "--name-only",
      published.workspaceTree,
    );
    expect(publishedPaths).toContain(".openclaw/project.json");
    expect(publishedPaths).not.toContain("sandbox-skills");
    expect(publishedPaths).not.toContain("guest-ignored");
    expect(await git(owner.worktree.path, "show", `${published.workspaceTree}:source.txt`)).toBe(
      "real sandbox edit",
    );
    const removed = await service.remove({
      id: owner.worktree.id,
      reason: "live-proof-archive",
    });
    expect(removed.removed).toBe(true);
    expect((await readRegistry()).entries).toEqual([]);
    await service.restore({ id: owner.worktree.id });
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "real sandbox edit\n",
    );
    expect(
      await fs.readFile(path.join(owner.worktree.path, ".openclaw/project.json"), "utf8"),
    ).toBe("valid project content\n");
    const restored = await resolveSandboxContext({
      config,
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      workspaceDir: owner.worktree.path,
    });
    expect(restored?.workspaceDir).toBe(sandbox.workspaceDir);
    expect(
      (await restored!.fsBridge!.readFile({ filePath: "guest-ignored/data" })).toString(),
    ).toBe("real ignored guest bytes\n");
    expect(await fs.readFile(path.join(owner.worktree.path, "guest-ignored/data"), "utf8")).toBe(
      "real ignored guest bytes\n",
    );
    await expect(fs.stat(path.join(restored!.workspaceDir, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await restored!.fsBridge!.readFile({ filePath: "source.txt" })).toString()).toBe(
      "real sandbox edit\n",
    );
    expect(
      (await service.remove({ id: owner.worktree.id, reason: "live-proof-retention" })).removed,
    ).toBe(true);
    now += SNAPSHOT_RETENTION_MS + 1;
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(localWorkspaceStore().get(owner.worktree.id)).toBeUndefined();
    await expect(fs.stat(sandbox.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    for (const runtime of (await readRegistry()).entries) {
      await removeSandboxContainer(runtime.containerName);
    }
  }
}
