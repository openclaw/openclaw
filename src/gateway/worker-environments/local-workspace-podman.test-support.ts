import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

async function expectText(root: string, relative: string, expected: string) {
  expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(expected);
}
async function expectMissing(root: string, relative: string) {
  await expect(fs.stat(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
}
const expectRejected = (operation: unknown, message?: string) =>
  expect(operation).rejects.toThrow(message);

const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);

function revocableAuthority(message: string) {
  return {
    current: true,
    assertCurrent() {
      if (!this.current) {
        throw new Error(message);
      }
    },
  };
}

/** Production required-Podman lifecycle proof, including revocation and selected cwd. */
export async function proveRequiredPodmanWorkspace(
  root: string,
  owner: LocalWorkspaceOwner,
  signal: AbortSignal,
  verifyCleanup: (body: () => Promise<void>) => Promise<void>,
) {
  const { worktree } = owner;
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
  const service = new ManagedWorktreeService();
  worktree.repoFingerprint = (await service.resolveRepositoryIdentity(worktree.path)).fingerprint;
  await insertRegistryWorktree(process.env, worktree, { provisionedPaths: [] });
  await upsertSessionEntryCore(
    { agentId: owner.agentId, sessionKey: owner.sessionKey },
    {
      sessionId: owner.sessionId,
      updatedAt: Date.now(),
      sandbox: "required",
      spawnedCwd: worktree.path,
      sessionRoot: worktree.path,
      worktree: {
        id: worktree.id,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        canonicalWorkspaceDir: worktree.repoRoot,
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
  async function expectGuestText(
    sandbox: NonNullable<Awaited<ReturnType<typeof resolveSandboxContext>>>,
    filePath: string,
    expected: string,
  ) {
    expect((await sandbox.fsBridge!.readFile({ filePath })).toString()).toBe(expected);
  }
  const sandboxContext = {
    config,
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: worktree.path,
  };
  const resolveSandbox = (authority?: ReturnType<typeof revocableAuthority>) =>
    resolveSandboxContext({
      ...sandboxContext,
      assertCurrent: authority && (() => authority.assertCurrent()),
    });
  type Sandbox = NonNullable<Awaited<ReturnType<typeof resolveSandbox>>>;
  async function execSandbox(
    sandbox: Sandbox,
    request: Parameters<NonNullable<Sandbox["backend"]>["buildExecSpec"]>[0],
  ) {
    const spec = await sandbox.backend!.buildExecSpec(request);
    const result = await runCommandWithTimeout(spec.argv, { baseEnv: spec.env, timeoutMs: 30000 });
    await sandbox.backend!.finalizeExec?.({
      status: result.code === 0 ? "completed" : "failed",
      exitCode: result.code,
      timedOut: false,
      token: spec.finalizeToken,
    });
    return result;
  }
  try {
    const engine = await import("../../agents/sandbox/container-engine.js");
    const execute = engine.execContainer;
    const allocation = revocableAuthority("allocation revoked");
    const effects: string[] = [];
    const observe = vi
      .spyOn(engine, "execContainer")
      .mockImplementation(async (target, args, options) => {
        const result = await execute(target, args, options);
        if (args[0] === "image" && args[1] === "inspect") {
          allocation.current = false;
        }
        if (["create", "start", "exec"].includes(args[0]!)) {
          effects.push(args[0]!);
        }
        return result;
      });
    try {
      await expectRejected(resolveSandbox(allocation), "allocation revoked");
      expect(effects).toEqual([]);
    } finally {
      observe.mockRestore();
    }
    const fileAuthority = revocableAuthority("filesystem owner revoked");
    const sandbox = await resolveSandbox(fileAuthority);
    expect(sandbox).toMatchObject({ required: true, workspaceAccess: "rw" });
    if (!sandbox?.backend || !sandbox.fsBridge) {
      throw new Error("Sandbox was not prepared");
    }
    const writeGuest = (filePath: string, data: string) =>
      sandbox.fsBridge!.writeFile({ filePath, data });
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
    const reconciliation = revocableAuthority("reconciliation revoked");
    await expect(
      withLocalWorkspaceProjection(
        {
          ...owner,
          assertCurrent: () => {
            owner.assertCurrent();
            reconciliation.assertCurrent();
          },
        },
        async () => {
          reconciliation.current = false;
        },
      ),
    ).rejects.toThrow("reconciliation revoked");
    const pausedState = () =>
      execute(runtimeEngine, ["inspect", "-f", "{{.State.Paused}}", sandbox.containerName]);
    expect((await pausedState()).stdout.trim()).toBe("true");
    expect((await readLocalWorkspaceProjection(worktree.id))?.paused_runtimes_json).toContain(
      sandbox.containerName,
    );
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect((await pausedState()).stdout.trim()).toBe("false");
    expect((await readLocalWorkspaceProjection(worktree.id))?.paused_runtimes_json).toBeNull();
    const skillScaffold = path.join(sandbox.workspaceDir, ".openclaw/sandbox-skills/skills");
    expect((await fs.stat(skillScaffold)).uid).toBe((await fs.stat(sandbox.workspaceDir)).uid);
    await writeGuest("source.txt", "real sandbox edit\n");
    await writeGuest(".gitignore", ".env.local\nguest-ignored/\n");
    await writeGuest("guest-ignored/data", "real ignored guest bytes\n");
    await writeGuest(".openclaw/project.json", "valid project content\n");
    await expectRejected(writeGuest(".openclaw/sandbox-skills/skills/forbidden", "must not write"));
    await expectText(worktree.path, "source.txt", "real sandbox edit\n");
    const result = await execSandbox(sandbox, {
      command:
        'git status --porcelain && test ! -e .env.local && test -z "$GH_TOKEN$GITHUB_TOKEN" && ! touch .openclaw/sandbox-skills/skills/.write-probe',
      usePty: false,
      env: {},
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("source.txt");
    const runShell = sandbox.backend.runShellCommand.bind(sandbox.backend);
    sandbox.backend.runShellCommand = async (command) => {
      const probeResult = await runShell(command);
      if (command.stdin === undefined) {
        fileAuthority.current = false;
      }
      return probeResult;
    };
    await expectRejected(
      writeGuest("revoked-write.txt", "must not write"),
      "filesystem owner revoked",
    );
    await expectMissing(sandbox.workspaceDir, "revoked-write.txt");
    await expectMissing(worktree.path, "revoked-write.txt");
    sandbox.backend.runShellCommand = runShell;
    const resumed = await resolveSandbox();
    expect(resumed?.workspaceDir).toBe(sandbox.workspaceDir);
    await expectGuestText(resumed!, "source.txt", "real sandbox edit\n");
    await expectText(worktree.repoRoot, "source.txt", "original\n");
    // A selected subdirectory changes execution cwd, not the projection/mount owner.
    const selected = path.join(worktree.path, "packages", "app");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, "selected.txt"), "selected source\n");
    await git(worktree.path, "add", "packages/app/selected.txt");
    const { resolveAttemptWorkspaceSandbox } = await import("../../agents/workspace-sandbox.js");
    const mapped = await resolveAttemptWorkspaceSandbox({
      ...sandboxContext,
      sessionId: owner.sessionId,
      workspaceDir: selected,
      cwd: selected,
      sessionRoot: worktree.path,
    });
    expect(mapped).toMatchObject({
      effectiveCwd: path.join(sandbox.workspaceDir, "packages", "app"),
      sessionPermissionRoot: sandbox.workspaceDir,
    });
    await mapped.sandbox!.fsBridge!.writeFile({
      filePath: "relative.txt",
      cwd: mapped.effectiveCwd,
      data: "selected write\n",
    });
    await expectText(selected, "relative.txt", "selected write\n");
    await expectMissing(worktree.path, "relative.txt");
    const selectedResult = await execSandbox(mapped.sandbox!, {
      command: "pwd; cat selected.txt",
      env: {},
      usePty: false,
      workdir: mapped.sandbox!.fsBridge!.resolvePath({
        filePath: ".",
        cwd: mapped.effectiveCwd,
      }).containerPath,
    });
    expect(selectedResult.code).toBe(0);
    expect(selectedResult.stdout).toContain("/packages/app\nselected source");

    // Termination custody survives revocation, but cannot admit another writer.
    const childAuthority = revocableAuthority("child owner revoked");
    const childSandbox = await resolveSandbox(childAuthority);
    const backend = childSandbox!.backend!;
    const { prepareSandboxProcessCleanup } =
      await import("../../agents/sandbox/process-cleanup.js");
    const cleanup = prepareSandboxProcessCleanup(backend, {});
    const childSpec = await backend.buildExecSpec({
      command:
        "echo tick >> child-writes; echo child-writes-ready; while :; do sleep 0.1; echo tick >> child-writes; done",
      env: cleanup.env,
      usePty: false,
    });
    childSpec.assertCurrent?.();
    const child = spawn(childSpec.argv[0]!, childSpec.argv.slice(1), {
      env: childSpec.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const [ready] = await withinTest(
        awaitGateBeforeSettlement(
          once(lines, "line", { signal }),
          closed,
          "Podman child exited before writing child-writes",
        ),
        signal,
      );
      expect(ready).toBe("child-writes-ready");
      expect(
        (await fs.stat(path.join(childSandbox!.workspaceDir, "child-writes"))).size,
      ).toBeGreaterThan(0);
      childAuthority.current = false;
      expect(() => prepareSandboxProcessCleanup(backend, {})).toThrow("child owner revoked");
      await expectRejected(
        backend.runShellCommand({ script: "touch forbidden-child-write" }),
        "child owner revoked",
      );
      await expectRejected(cleanup.interrupt(1000), "child owner revoked");
      await cleanup.terminate();
      await withinTest(closed, signal);
      const stoppedBytes = await fs.readFile(path.join(childSandbox!.workspaceDir, "child-writes"));
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(await fs.readFile(path.join(childSandbox!.workspaceDir, "child-writes"))).toEqual(
        stoppedBytes,
      );
      await expectRejected(
        backend.finalizeExec?.({
          status: "failed",
          exitCode: child.exitCode,
          timedOut: false,
          token: childSpec.finalizeToken,
        }),
        "child owner revoked",
      );
    } finally {
      await verifyCleanup(() =>
        runQaGatewayFixture(
          async () => {
            lines.close();
            await cleanup.terminate();
          },
          async () => {
            child.kill("SIGKILL");
            await closed;
          },
        ),
      );
    }
    // The source-only fixture deliberately installed an unsafe host helper.
    // Publication must reject it, then succeed only after the fixture owner removes it.
    await expectRejected(
      captureGitHubPublicationWorkspaceSnapshot({ cwd: worktree.path }),
      "unsupported Git transport",
    );
    await git(worktree.repoRoot, "config", "--unset-all", "credential.helper");
    const published = await captureGitHubPublicationWorkspaceSnapshot({
      cwd: worktree.path,
      assertCurrent: owner.assertCurrent,
    });
    const publishedPaths = await git(
      worktree.path,
      "ls-tree",
      "-r",
      "--name-only",
      published.workspaceTree,
    );
    expect(publishedPaths).toContain(".openclaw/project.json");
    expect(publishedPaths).not.toContain("sandbox-skills");
    expect(publishedPaths).not.toContain("guest-ignored");
    expect(await git(worktree.path, "show", `${published.workspaceTree}:source.txt`)).toBe(
      "real sandbox edit",
    );
    const removed = await service.remove({
      id: worktree.id,
      reason: "live-proof-archive",
    });
    expect(removed.removed).toBe(true);
    expect((await readRegistry()).entries).toEqual([]);
    await service.restore({ id: worktree.id });
    await expectText(worktree.path, "source.txt", "real sandbox edit\n");
    await expectText(worktree.path, ".openclaw/project.json", "valid project content\n");
    const restored = await resolveSandbox();
    expect(restored?.workspaceDir).toBe(sandbox.workspaceDir);
    await expectGuestText(restored!, "guest-ignored/data", "real ignored guest bytes\n");
    await expectText(worktree.path, "guest-ignored/data", "real ignored guest bytes\n");
    await expectMissing(restored!.workspaceDir, ".env.local");
    await expectGuestText(restored!, "source.txt", "real sandbox edit\n");
    expect(
      (await service.remove({ id: worktree.id, reason: "live-proof-retention" })).removed,
    ).toBe(true);
    await updateRegistryWorktree(process.env, worktree.id, {
      removedAt: Date.now() - SNAPSHOT_RETENTION_MS - 1,
    });
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(await readLocalWorkspaceProjection(worktree.id)).toBeUndefined();
    await expect(fs.stat(sandbox.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await verifyCleanup(async () => {
      const runtimes = (await readRegistry()).entries;
      await runQaGatewayFixture(
        async () => {},
        ...runtimes.map((runtime) => () => removeSandboxContainer(runtime.containerName)),
      );
    });
  }
}
