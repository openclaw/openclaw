import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { registerSandboxBackend } from "../sandbox/backend.js";
import type { CreateSandboxBackendParams } from "../sandbox/backend.types.js";
import { hashTextSha256 } from "../sandbox/hash.js";
import { getRegistryWorktree, insertRegistryWorktree } from "./registry.js";
import { createWorktreeGitExecutor } from "./sandbox-git.js";

const cleanups: Array<() => void | Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  closeOpenClawStateDatabaseForTest();
});

async function createRepositoryFixture() {
  const root = tempDirs.make("openclaw-sandbox-git-");
  await fs.mkdir(path.join(root, ".git"));
  return root;
}

function sandboxConfig(stateDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "rw",
          docker: { env: { AUTHORIZED_TOKEN: "agent-token" } },
        },
      },
    },
    worktreeRoot: path.join(stateDir, "worktrees"),
  };
}

describe("managed worktree sandbox Git executor", () => {
  it("dispatches Git through a dedicated sandbox with only authorized environment", async () => {
    const root = await createRepositoryFixture();
    const calls: Array<{
      script: string;
      args?: string[];
      env?: Record<string, string>;
      terminateOnAbort?: boolean;
    }> = [];
    const scopeKeys: string[] = [];
    const disposed: string[] = [];
    let createParams: CreateSandboxBackendParams | undefined;
    const restore = registerSandboxBackend("docker", async (params) => {
      createParams = params;
      scopeKeys.push(params.scopeKey);
      const runtimeId = `provisioning-test-${scopeKeys.length}`;
      return {
        id: "docker",
        runtimeId,
        runtimeLabel: "provisioning-test",
        workdir: "/workspace",
        buildExecSpec: vi.fn(),
        async runShellCommand(command) {
          calls.push(command);
          if (command.args?.includes("rev-parse")) {
            return { stdout: Buffer.from(".git\n"), stderr: Buffer.alloc(0), code: 0 };
          }
          if (command.args?.includes("remote.origin.url")) {
            return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 };
          }
          return { stdout: Buffer.from("sandboxed\n"), stderr: Buffer.alloc(0), code: 0 };
        },
        async disposeRuntime() {
          disposed.push(runtimeId);
        },
      };
    });
    cleanups.push(restore);
    const config = sandboxConfig(root);

    const stateDir = path.join(root, "state");
    const snapshotDir = path.join(stateDir, "worktree-tmp", "index-operation");
    await fs.mkdir(snapshotDir, { recursive: true });
    const snapshotIndex = path.join(snapshotDir, "index");
    const executor = await createWorktreeGitExecutor({
      isolation: { config, sessionKey: "agent:main:subagent:test" },
      repoRoot: root,
      allocationRoot: path.join(root, "allocation"),
      env: { OPENCLAW_STATE_DIR: stateDir, HOST_SECRET: "gateway-only" },
    });
    const result = await executor?.run(root, ["status", "--porcelain"], {
      env: { GIT_INDEX_FILE: snapshotIndex, HOST_SECRET: "do-not-forward" },
    });

    expect(result?.stdout).toBe("sandboxed\n");
    expect(createParams?.scopeKey).toMatch(/^worktree-provisioning:/);
    expect(scopeKeys).toHaveLength(3);
    expect(new Set(scopeKeys).size).toBe(3);
    expect(createParams?.internalMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostPath: root, containerPath: root, readOnly: false }),
        expect.objectContaining({
          hostPath: snapshotDir,
          containerPath: snapshotDir,
          readOnly: false,
        }),
      ]),
    );
    expect(
      createParams?.internalMounts?.some(
        (mount) => mount.hostPath === path.join(stateDir, "worktree-tmp"),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(3);
    const gitCall = calls.at(-1);
    expect(gitCall?.script).toContain("exec env -i");
    expect(gitCall?.args?.join(" ")).not.toContain("agent-token");
    expect(gitCall?.env).toMatchObject({
      AUTHORIZED_TOKEN: "agent-token",
      GIT_INDEX_FILE: snapshotIndex,
    });
    expect(gitCall?.args?.some((entry) => entry.includes("HOST_SECRET"))).toBe(false);
    expect(gitCall?.env).not.toHaveProperty("HOST_SECRET");
    expect(gitCall?.env).toMatchObject({ GIT_CONFIG_KEY_0: "core.hooksPath" });
    expect(gitCall?.terminateOnAbort).toBe(true);
    await executor?.dispose?.();
    expect(disposed).toHaveLength(3);

    const secondExecutor = await createWorktreeGitExecutor({
      isolation: { config, sessionKey: "agent:main:subagent:test" },
      repoRoot: root,
      allocationRoot: path.join(root, "allocation"),
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
    await secondExecutor?.dispose?.();
    expect(scopeKeys).toHaveLength(5);
    expect(new Set(scopeKeys).size).toBe(5);
    expect(disposed).toHaveLength(5);
  });

  it("marks primary-checkout siblings before creating the first provisioning backend", async () => {
    const root = await createRepositoryFixture();
    const source = path.join(root, "packages", "app");
    await fs.mkdir(source, { recursive: true });
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    insertRegistryWorktree(env, {
      id: "manual-sibling",
      name: "manual",
      repoFingerprint: "0123456789abcdef",
      repoRoot: root,
      path: path.join(root, "manual"),
      branch: "manual",
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    });
    let taintedAtBackendCreation = false;
    const restore = registerSandboxBackend("docker", async () => {
      taintedAtBackendCreation = getRegistryWorktree(env, "manual-sibling")?.sandboxGit === true;
      return {
        id: "docker",
        runtimeId: "primary-provisioning-test",
        runtimeLabel: "primary-provisioning-test",
        workdir: "/workspace",
        buildExecSpec: vi.fn(),
        async runShellCommand(command) {
          return command.args?.includes("rev-parse")
            ? {
                stdout: Buffer.from(`${path.join(root, ".git")}\n`),
                stderr: Buffer.alloc(0),
                code: 0,
              }
            : { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 };
        },
        disposeRuntime: vi.fn(),
      };
    });
    cleanups.push(restore);

    await createWorktreeGitExecutor({
      isolation: { config: sandboxConfig(root), sessionKey: "agent:main:subagent:test" },
      repoRoot: source,
      env,
    });
    expect(taintedAtBackendCreation).toBe(true);
  });

  it("mounts only the admitted destination instead of neighboring worktrees", async () => {
    const root = await createRepositoryFixture();
    const creations: CreateSandboxBackendParams[] = [];
    const restore = registerSandboxBackend("docker", async (params) => {
      creations.push(params);
      return {
        id: "docker",
        runtimeId: `provisioning-${creations.length}`,
        runtimeLabel: "provisioning-test",
        workdir: "/workspace",
        buildExecSpec: vi.fn(),
        async runShellCommand(command) {
          if (command.args?.includes("rev-parse")) {
            return { stdout: Buffer.from(".git\n"), stderr: Buffer.alloc(0), code: 0 };
          }
          if (command.args?.includes("remote.origin.url")) {
            return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 };
          }
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
        },
        disposeRuntime: vi.fn(),
      };
    });
    cleanups.push(restore);
    const config = sandboxConfig(root);
    const commonDir = path.join(root, ".git");
    const fingerprint = hashTextSha256(`${commonDir}\n`).slice(0, 16);
    const parent = path.join(config.worktreeRoot!, fingerprint);
    const destination = path.join(parent, "admitted");
    const neighbor = path.join(parent, "neighbor");
    await fs.mkdir(neighbor, { recursive: true });
    const executor = await createWorktreeGitExecutor({
      isolation: { config, sessionKey: "agent:main:subagent:test" },
      repoRoot: root,
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    });

    await executor?.run(
      root,
      ["worktree", "add", "-b", "openclaw/admitted", "--", destination, "HEAD"],
      {},
    );

    const mounts = creations.at(-1)?.internalMounts ?? [];
    expect(mounts).toContainEqual({
      hostPath: destination,
      containerPath: destination,
      readOnly: false,
    });
    expect(mounts.some((mount) => mount.hostPath === parent || mount.hostPath === neighbor)).toBe(
      false,
    );
    await executor?.run(root, ["worktree", "remove", "--force", "--", destination], {});
    expect(creations.at(-1)?.internalMounts?.some((mount) => mount.hostPath === neighbor)).toBe(
      false,
    );
  });

  it("fails closed when the provisioning backend cannot start", async () => {
    const root = await createRepositoryFixture();
    const restore = registerSandboxBackend("docker", async () => {
      throw new Error("container runtime unavailable");
    });
    cleanups.push(restore);

    await expect(
      createWorktreeGitExecutor({
        isolation: {
          config: sandboxConfig(root),
          sessionKey: "agent:main:subagent:test",
        },
        repoRoot: root,
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      }),
    ).rejects.toThrow("container runtime unavailable");
  });

  it("retains host Git for trusted source provenance", async () => {
    const root = await createRepositoryFixture();
    await expect(createWorktreeGitExecutor({ repoRoot: root })).resolves.toBeUndefined();
  });
});
