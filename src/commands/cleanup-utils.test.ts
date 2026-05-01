import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultPrimaryModel } from "../plugins/provider-model-primary.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildCleanupPlan,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

describe("buildCleanupPlan", () => {
  test("resolves inside-state flags and workspace dirs", () => {
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp");
    const cfg = {
      agents: {
        defaults: { workspace: path.join(tmpRoot, "openclaw-workspace-1") },
        list: [{ workspace: path.join(tmpRoot, "openclaw-workspace-2") }],
      },
    };
    const plan = buildCleanupPlan({
      cfg: cfg as unknown as OpenClawConfig,
      stateDir: path.join(tmpRoot, "openclaw-state"),
      configPath: path.join(tmpRoot, "openclaw-state", "openclaw.json"),
      oauthDir: path.join(tmpRoot, "openclaw-oauth"),
    });

    expect(plan.configInsideState).toBe(true);
    expect(plan.oauthInsideState).toBe(false);
    expect(new Set(plan.workspaceDirs)).toEqual(
      new Set([
        path.join(tmpRoot, "openclaw-workspace-1"),
        path.join(tmpRoot, "openclaw-workspace-2"),
      ]),
    );
  });
});

describe("applyAgentDefaultPrimaryModel", () => {
  it("does not mutate when already set", () => {
    const cfg = { agents: { defaults: { model: { primary: "a/b" } } } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({ cfg, model: "a/b" });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(cfg);
  });

  it("normalizes legacy models", () => {
    const cfg = { agents: { defaults: { model: { primary: "legacy" } } } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({
      cfg,
      model: "a/b",
      legacyModels: new Set(["legacy"]),
    });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(cfg);
  });
});

describe("cleanup path removals", () => {
  function createRuntimeMock() {
    return {
      log: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    } as unknown as RuntimeEnv & {
      log: ReturnType<typeof vi.fn<(message: string) => void>>;
      error: ReturnType<typeof vi.fn<(message: string) => void>>;
    };
  }

  it("removes state and only linked paths outside state", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp", "openclaw-cleanup");
    await removeStateAndLinkedPaths(
      {
        stateDir: path.join(tmpRoot, "state"),
        configPath: path.join(tmpRoot, "state", "openclaw.json"),
        oauthDir: path.join(tmpRoot, "oauth"),
        configInsideState: true,
        oauthInsideState: false,
      },
      runtime,
      { dryRun: true },
    );

    const joinedLogs = runtime.log.mock.calls
      .map(([line]) => line.replaceAll("\\", "/"))
      .join("\n");
    expect(joinedLogs).toContain("/tmp/openclaw-cleanup/state");
    expect(joinedLogs).toContain("/tmp/openclaw-cleanup/oauth");
    expect(joinedLogs).not.toContain("openclaw.json");
  });

  it("removes every workspace directory", async () => {
    const runtime = createRuntimeMock();
    const workspaces = ["/tmp/openclaw-workspace-1", "/tmp/openclaw-workspace-2"];

    await removeWorkspaceDirs(workspaces, runtime, { dryRun: true });

    const logs = runtime.log.mock.calls.map(([line]) => line);
    expect(logs).toContain("[dry-run] remove /tmp/openclaw-workspace-1");
    expect(logs).toContain("[dry-run] remove /tmp/openclaw-workspace-2");
  });

  it("refuses to prune an unsafe state-dir root even when a workspace is inside it (#75052 security)", async () => {
    // Regression: removeStateDirAroundWorkspaces must apply the same unsafe-target guard as
    // removePath. Without the guard, OPENCLAW_STATE_DIR=$HOME with a workspace below HOME
    // would enumerate and delete home directory children instead of refusing.
    const runtime = createRuntimeMock();
    const homeDir = path.resolve(process.env["HOME"] ?? os.homedir());
    // A synthetic workspace path that is inside $HOME — triggers the pruning branch.
    const workspaceInsideHome = path.join(homeDir, ".openclaw", "workspaces", "main");

    await removeStateAndLinkedPaths(
      {
        stateDir: homeDir,
        configPath: path.join(homeDir, ".openclaw.json"),
        oauthDir: path.join(homeDir, ".openclaw-oauth"),
        configInsideState: false,
        oauthInsideState: false,
      },
      runtime,
      { dryRun: false, workspaceDirsToPreserve: [workspaceInsideHome] },
    );

    // Must have logged a refusal, never removed anything.
    const errors = runtime.error.mock.calls.map(([line]: [string]) => line);
    expect(errors.some((e: string) => e.includes("Refusing to remove unsafe path"))).toBe(true);
    // Home directory itself must still exist.
    await expect(fs.access(homeDir)).resolves.toBeUndefined();
  });

  it("refuses to prune a symlinked state-dir root even when a workspace is inside it (#75052 security)", async () => {
    // Regression: removeStateDirAroundWorkspaces must refuse when OPENCLAW_STATE_DIR is a symlink.
    // Without this guard, fs.readdir follows the symlink and can enumerate/delete children of an
    // unrelated target directory even though the apparent workspace-preservation path check passes.
    const runtime = createRuntimeMock();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-75052-symlink-"));
    try {
      const realStateDir = path.join(tmpDir, "real-state");
      const symlinkStateDir = path.join(tmpDir, "link-state");
      const workspaceInsideSymlink = path.join(symlinkStateDir, "workspace");
      await fs.mkdir(realStateDir, { recursive: true });
      await fs.symlink(realStateDir, symlinkStateDir);
      await fs.mkdir(path.join(realStateDir, "workspace"), { recursive: true });
      await fs.writeFile(path.join(realStateDir, "token.json"), "{}\n", "utf8");

      await removeStateAndLinkedPaths(
        {
          stateDir: symlinkStateDir,
          configPath: path.join(symlinkStateDir, "openclaw.json"),
          oauthDir: path.join(tmpDir, "oauth"),
          configInsideState: true,
          oauthInsideState: false,
        },
        runtime,
        { dryRun: false, workspaceDirsToPreserve: [workspaceInsideSymlink] },
      );

      const errors = runtime.error.mock.calls.map(([line]: [string]) => line);
      expect(errors.some((e: string) => e.includes("Refusing to prune symlinked state root"))).toBe(
        true,
      );
      // Real state directory contents must be untouched.
      await expect(fs.access(path.join(realStateDir, "token.json"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prunes state dir contents around a preserved workspace, keeping other state data removed", async () => {
    // Regression for openclaw/openclaw#75052: uninstalling with state scope but not workspace
    // scope must remove state data (config, credentials) while preserving the workspace subtree.
    const runtime = createRuntimeMock();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-75052-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      const workspaceInsideState = path.join(stateDir, "workspaces", "main");
      // Populate state dir with config, credentials, and workspace
      await fs.mkdir(path.join(stateDir, "workspaces", "main"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "openclaw.json"), "{}\n", "utf8");
      await fs.writeFile(path.join(stateDir, "credentials", "token.json"), "{}\n", "utf8");
      await fs.writeFile(path.join(workspaceInsideState, "agent.jsonl"), "{}\n", "utf8");

      await removeStateAndLinkedPaths(
        {
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          oauthDir: path.join(tmpDir, "oauth"),
          configInsideState: true,
          oauthInsideState: false,
        },
        runtime,
        { dryRun: false, workspaceDirsToPreserve: [workspaceInsideState] },
      );

      // State-level items removed: config and credentials
      await expect(fs.access(path.join(stateDir, "openclaw.json"))).rejects.toThrow();
      await expect(fs.access(path.join(stateDir, "credentials"))).rejects.toThrow();
      // Workspace preserved
      await expect(
        fs.access(path.join(workspaceInsideState, "agent.jsonl")),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
