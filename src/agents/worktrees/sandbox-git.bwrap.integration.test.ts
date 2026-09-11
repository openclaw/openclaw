import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { executeGitCommand } from "../../infra/git-exec.js";
import { runCommandBuffered } from "../../process/exec.js";
import type { Deferred } from "../../shared/deferred.js";
import { registerSandboxBackend } from "../sandbox/backend.js";
import type { CreateSandboxBackendParams } from "../sandbox/backend.types.js";
import { resolveSandboxContext } from "../sandbox/context.js";
import { deleteRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";

const canRunBwrap = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const cleanups: Array<() => void | Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.unstubAllEnvs();
});

async function git(cwd: string, args: string[]) {
  const result = await executeGitCommand(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe.skipIf(!canRunBwrap)("managed worktree provisioning namespace", () => {
  it("contains transport and checkout commands across create, snapshot, and restore", async () => {
    const root = tempDirs.make("openclaw-worktree-boundary-");
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "worktrees");
    const transportMarker = path.join(root, "gateway-transport-marker");
    const filterMarker = path.join(root, "gateway-filter-marker");
    const sandboxTransportMarker = path.join(repo, "sandbox-transport-marker");
    const sandboxFilterMarker = path.join(repo, "sandbox-filter-marker");
    const sandboxCredentialMarker = path.join(repo, "sandbox-credential-marker");
    const sshCommand = path.join(repo, "ssh-command.sh");
    const filterCommand = path.join(repo, "filter-command.sh");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "OpenClaw Test"]);
    await git(repo, ["config", "user.email", "openclaw-test@localhost"]);
    await fs.writeFile(path.join(repo, ".gitattributes"), "tracked.txt filter=escape\n");
    await fs.writeFile(path.join(repo, "tracked.txt"), "original\n");
    await fs.writeFile(
      sshCommand,
      `#!/usr/bin/sh\nprintf transport > ${sandboxTransportMarker}\nprintf '%s' "$AUTHORIZED_REPO_TOKEN" > ${sandboxCredentialMarker}\nprintf transport > ${transportMarker}\nexit 1\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      filterCommand,
      `#!/usr/bin/sh\nprintf filter > ${sandboxFilterMarker}\nprintf filter > ${filterMarker}\ncat\n`,
      { mode: 0o755 },
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "fixture"]);
    await git(repo, ["remote", "add", "origin", "ssh://127.0.0.1:1/example/repo.git"]);
    await git(repo, ["config", "core.sshCommand", sshCommand]);
    await git(repo, ["config", "filter.escape.smudge", filterCommand]);

    const backendCreations: CreateSandboxBackendParams[] = [];
    let blockedDisposal: { started: Deferred; release: Deferred } | undefined;
    const restoreBackend = registerSandboxBackend("docker", async (params) => {
      backendCreations.push(params);
      const runtimeId = `bwrap-worktree-provisioning-${backendCreations.length}`;
      return {
        id: "docker",
        runtimeId,
        runtimeLabel: "bwrap-worktree-provisioning",
        workdir: "/workspace",
        async buildExecSpec() {
          throw new Error("not used by this test backend");
        },
        async runShellCommand(command) {
          const bwrapArgs = [
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--ro-bind",
            "/etc",
            "/etc",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--bind",
            params.workspaceDir,
            params.cfg.docker.workdir,
          ];
          for (const mount of params.internalMounts ?? []) {
            bwrapArgs.push(
              mount.readOnly ? "--ro-bind" : "--bind",
              mount.hostPath,
              mount.containerPath,
            );
          }
          bwrapArgs.push(
            "--unshare-all",
            "--die-with-parent",
            "/usr/bin/sh",
            "-c",
            command.script,
            "openclaw-worktree-test",
            ...(command.args ?? []),
          );
          const result = await runCommandBuffered(["bwrap", ...bwrapArgs], {
            env: command.env,
            input: command.stdin,
            signal: command.signal,
          });
          return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? 1 };
        },
        async disposeRuntime() {
          const blocked = blockedDisposal;
          if (blocked) {
            blockedDisposal = undefined;
            blocked.started.resolve(undefined);
            await blocked.release.promise;
          }
        },
      };
    });
    cleanups.push(restoreBackend);

    const config: OpenClawConfig = {
      worktreeRoot,
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "rw",
            backend: "docker",
            docker: { env: { AUTHORIZED_REPO_TOKEN: "agent-repository-token" } },
          },
        },
      },
    };
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    let activeConfig = config;
    const service = new ManagedWorktreeService({
      env,
      getConfig: () => config,
      getRuntimeConfig: () => activeConfig,
    });
    const isolation = { config, sessionKey: "agent:main:subagent:boundary" };

    const created = await service.create({
      repoRoot: repo,
      name: "sandbox-boundary",
      ownerKind: "session",
      ownerId: isolation.sessionKey,
      gitIsolation: isolation,
    });
    expect(created.sandboxGit).toBe(true);
    expect(await fs.readFile(path.join(created.path, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await fs.readFile(sandboxTransportMarker, "utf8")).toBe("transport");
    expect(await fs.readFile(sandboxFilterMarker, "utf8")).toBe("filter");
    expect(await fs.readFile(sandboxCredentialMarker, "utf8")).toBe("agent-repository-token");
    await expect(fs.stat(transportMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(created.path, "tracked.txt"), "restored change\n");
    const originalSibling = await service.create({
      repoRoot: repo,
      name: "sandbox-original-sibling",
      ownerKind: "manual",
    });
    const siblingGitdir = await fs.realpath(
      path.resolve(
        originalSibling.path,
        (await fs.readFile(path.join(originalSibling.path, ".git"), "utf8"))
          .trim()
          .replace(/^gitdir:\s*/, ""),
      ),
    );
    activeConfig = {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          sandbox: { ...config.agents?.defaults?.sandbox, mode: "off" },
        },
      },
    };
    const removed = await service.remove({ id: created.id, reason: "boundary-test" });
    expect(removed.snapshotRef).toBeTruthy();
    await expect(fs.stat(siblingGitdir)).resolves.toBeDefined();
    expect(originalSibling.sandboxGit).toBe(true);
    await expect(fs.stat(transportMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });
    config.worktreeRoot = path.join(root, "replacement-worktree-root");
    const restored = await service.create({
      repoRoot: repo,
      name: created.name,
      ownerKind: "session",
      ownerId: isolation.sessionKey,
    });
    expect(restored.path).toBe(created.path);
    expect(await fs.readFile(path.join(restored.path, "tracked.txt"), "utf8")).toBe(
      "restored change\n",
    );
    const descendant = await service.create({
      repoRoot: restored.path,
      name: "sandbox-descendant",
      ownerKind: "session",
      ownerId: "agent:other:subagent:descendant",
    });
    expect(descendant.sandboxGit).toBe(true);
    await expect(fs.stat(transportMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });

    const childSandbox = await resolveSandboxContext({
      config,
      sessionKey: isolation.sessionKey,
      workspaceDir: restored.path,
    });
    const commonDir = await fs.realpath(path.join(repo, ".git"));
    expect(backendCreations.at(-1)?.internalMounts).toContainEqual({
      hostPath: commonDir,
      containerPath: commonDir,
      readOnly: false,
    });
    const childGit = await childSandbox?.backend?.runShellCommand({
      script: 'exec "$@"',
      args: ["git", "-C", childSandbox.containerWorkdir, "rev-parse", "--show-toplevel"],
    });
    expect(childGit?.code).toBe(0);
    expect(childGit?.stdout.toString("utf8").trim()).toBe(childSandbox?.containerWorkdir);

    const disposalStarted = createDeferred();
    const releaseDisposal = createDeferred();
    blockedDisposal = { started: disposalStarted, release: releaseDisposal };
    const firstDuringDisposal = service.create({
      repoRoot: repo,
      name: "disposal-owner",
      ownerKind: "manual",
    });
    await disposalStarted.promise;
    const creationsBeforeCompetitor = backendCreations.length;
    const competingCreate = service.create({
      repoRoot: repo,
      name: "disposal-competitor",
      ownerKind: "manual",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(backendCreations).toHaveLength(creationsBeforeCompetitor);
    releaseDisposal.resolve(undefined);
    await firstDuringDisposal;
    await competingCreate;

    deleteRegistryWorktree(env, created.id);
    deleteRegistryWorktree(env, descendant.id);
    await service.remove({ id: originalSibling.id, reason: "post-retention-boundary-test" });
    deleteRegistryWorktree(env, originalSibling.id);
    const postRetention = await service.create({
      repoRoot: repo,
      name: "post-retention",
      ownerKind: "manual",
    });
    expect(postRetention.sandboxGit).toBe(true);
    await expect(fs.stat(transportMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
