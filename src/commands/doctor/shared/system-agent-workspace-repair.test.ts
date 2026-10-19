// System agent workspace repair tests cover which directory Doctor pins for a converged roster.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default-path.js";
import { ensureAgentWorkspace } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { repairSystemAgentWorkspacePin } from "./system-agent-workspace-repair.js";

let testState: OpenClawTestState;
let root: string;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-system-agent-workspace-",
  });
  root = testState.path("shared");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
});

function convergedRoster(main: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { workspace: root, systemAgent: { agentId: "main" } },
      entries: { main, dev: {} },
    },
  } as OpenClawConfig;
}

async function writePersona(dir: string, soul: string) {
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, "SOUL.md"), soul);
}

describe("repairSystemAgentWorkspacePin", () => {
  it("copies the shared root's files over the agent's seeded files, then pins it", async () => {
    const agentDir = path.join(root, "main");
    await writePersona(root, "root persona");
    await fs.writeFile(path.join(root, "memory", "2026-10-01.md"), "root note");
    await fs.mkdir(path.join(root, "skills", "deploy"), { recursive: true });
    await fs.writeFile(path.join(root, "skills", "deploy", "SKILL.md"), "deploy skill");
    await ensureAgentWorkspace({ dir: agentDir, ensureBootstrapFiles: true });
    const seededSoul = await fs.readFile(path.join(agentDir, "SOUL.md"), "utf8");
    const cfg = convergedRoster();

    const planned = await repairSystemAgentWorkspacePin(cfg, testState.env);

    // The preview leaves the pin out: accepting it reruns the repair with the copy.
    expect(planned.config).toBe(cfg);
    expect(planned.restorePending).toBe(true);
    expect(planned.warnings).toBeUndefined();
    expect(planned.changes).toEqual([
      `Copy SOUL.md, ${path.join("memory", "2026-10-01.md")}, ${path.join("skills", "deploy", "SKILL.md")} from ${root} into ${agentDir}; the files in ${root} stay in place.`,
      `Set agents.entries.main.workspace to ${agentDir} so its working directory, persona, and memory use one workspace.`,
    ]);
    expect(await fs.readFile(path.join(agentDir, "SOUL.md"), "utf8")).toBe(seededSoul);

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.explicitSetPaths).toEqual([["agents", "entries", "main", "workspace"]]);
    expect(result.warnings).toBeUndefined();
    expect(result.changes).toEqual([
      expect.stringMatching(/^Copied SOUL\.md, /),
      `Set agents.entries.main.workspace to ${agentDir} so its working directory, persona, and memory use one workspace.`,
    ]);
    expect(await fs.readFile(path.join(agentDir, "SOUL.md"), "utf8")).toBe("root persona");
    expect(await fs.readFile(path.join(agentDir, "memory", "2026-10-01.md"), "utf8")).toBe(
      "root note",
    );
    expect(await fs.readFile(path.join(agentDir, "skills", "deploy", "SKILL.md"), "utf8")).toBe(
      "deploy skill",
    );
    expect(await fs.readFile(path.join(root, "SOUL.md"), "utf8")).toBe("root persona");
    expect(await fs.readFile(path.join(root, "memory", "2026-10-01.md"), "utf8")).toBe("root note");
  });

  it("recreates linked skills in the agent directory pointing where the root's links do", async () => {
    const agentDir = path.join(root, "main");
    const shared = testState.path("shared-skills");
    await fs.mkdir(path.join(shared, "deploy"), { recursive: true });
    await fs.writeFile(path.join(shared, "deploy", "SKILL.md"), "linked skill");
    await writePersona(root, "root persona");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.symlink(path.join(shared, "deploy"), path.join(root, "skills", "absolute"));
    await fs.symlink(
      path.join("..", "..", "shared-skills", "deploy"),
      path.join(root, "skills", "relative"),
    );

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.changes[0]).toBe(
      `Copied SOUL.md, ${path.join("skills", "absolute")}, ${path.join("skills", "relative")} from ${root} into ${agentDir}; the files in ${root} stay in place.`,
    );
    for (const name of ["absolute", "relative"]) {
      const link = path.join(agentDir, "skills", name);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toBe("linked skill");
    }
    expect(await fs.readlink(path.join(root, "skills", "relative"))).toBe(
      path.join("..", "..", "shared-skills", "deploy"),
    );
  });

  it("keeps a linked file in the agent directory instead of writing through it", async () => {
    const agentDir = path.join(root, "main");
    const elsewhere = testState.path("elsewhere-soul.md");
    await ensureAgentWorkspace({ dir: agentDir, ensureBootstrapFiles: true });
    const seededSoul = await fs.readFile(path.join(agentDir, "SOUL.md"), "utf8");
    await fs.writeFile(elsewhere, seededSoul);
    await fs.rm(path.join(agentDir, "SOUL.md"));
    await fs.symlink(elsewhere, path.join(agentDir, "SOUL.md"));
    await writePersona(root, "root persona");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.changes).toContain(
      `Kept SOUL.md in ${agentDir}; the different copies in ${root} stay in place.`,
    );
    expect(await fs.readFile(elsewhere, "utf8")).toBe(seededSoul);
  });

  it("keeps linked directories in the agent directory instead of copying into them", async () => {
    const agentDir = path.join(root, "main");
    const devMemory = path.join(root, "dev", "memory");
    const elsewhere = testState.path("elsewhere-skill");
    await ensureAgentWorkspace({ dir: agentDir, ensureBootstrapFiles: true });
    await fs.mkdir(devMemory, { recursive: true });
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.symlink(devMemory, path.join(agentDir, "memory"));
    await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
    await fs.symlink(elsewhere, path.join(agentDir, "skills", "deploy"));
    await writePersona(root, "root persona");
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    await fs.writeFile(path.join(root, "memory", "private.md"), "main's private memory");
    await fs.mkdir(path.join(root, "skills", "deploy"), { recursive: true });
    await fs.writeFile(path.join(root, "skills", "deploy", "SKILL.md"), "root skill");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.changes).toContain(
      `Kept memory, ${path.join("skills", "deploy")} in ${agentDir}; the different copies in ${root} stay in place.`,
    );
    expect(await fs.readdir(devMemory)).toEqual([]);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect((await fs.lstat(path.join(agentDir, "memory"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(agentDir, "SOUL.md"), "utf8")).toBe("root persona");
    expect(await fs.readFile(path.join(root, "memory", "private.md"), "utf8")).toBe(
      "main's private memory",
    );
  });

  it("counts a customized AGENTS.md as files in either directory", async () => {
    await fs.writeFile(path.join(root, "SOUL.md"), "root persona");
    await fs.mkdir(path.join(root, "main"), { recursive: true });
    await fs.writeFile(path.join(root, "main", "AGENTS.md"), "customized agent rules");
    const cfg = convergedRoster();

    const both = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(both.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
    expect(both.changes[0]).toMatch(/^Copied SOUL\.md from /);
    expect(await fs.readFile(path.join(root, "main", "SOUL.md"), "utf8")).toBe("root persona");
    expect(await fs.readFile(path.join(root, "main", "AGENTS.md"), "utf8")).toBe(
      "customized agent rules",
    );

    await fs.writeFile(path.join(root, "AGENTS.md"), "customized root rules");
    await fs.rm(path.join(root, "main", "AGENTS.md"));
    const rootOnly = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });
    expect(rootOnly.changes[0]).toMatch(/^Copied AGENTS\.md from /);
    expect(await fs.readFile(path.join(root, "main", "AGENTS.md"), "utf8")).toBe(
      "customized root rules",
    );
  });

  it("keeps the authored env reference in the pin and resolves to the same directory", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");
    const env = { ...testState.env, WORKSPACE_ROOT: root };
    const cfg = convergedRoster();
    cfg.agents!.defaults!.workspace = root;

    const result = await repairSystemAgentWorkspacePin(cfg, env, {
      authoredDefaultWorkspace: "${WORKSPACE_ROOT}/",
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe("${WORKSPACE_ROOT}/main");
    expect(result.explicitSetPaths).toEqual([["agents", "entries", "main", "workspace"]]);
    // Moving the variable moves defaults and the pin together.
    const moved = path.join(testState.path("elsewhere"));
    const resolved = structuredClone(result.config);
    resolved.agents!.entries!.main!.workspace = "${WORKSPACE_ROOT}/main".replace(
      "${WORKSPACE_ROOT}",
      moved,
    );
    resolved.agents!.defaults!.workspace = moved;
    expect(resolveAgentWorkspaceDir(resolved, "main", env)).toBe(path.join(moved, "main"));
  });

  it("keeps a tilde root as authored", async () => {
    const home = testState.path("home");
    const env = { ...testState.env, HOME: home };
    await writePersona(path.join(home, "x", "main"), "subdirectory persona");
    const cfg = convergedRoster();
    cfg.agents!.defaults!.workspace = "~/x";

    const result = await repairSystemAgentWorkspacePin(cfg, env, {
      authoredDefaultWorkspace: "~/x",
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe("~/x/main");
    expect(resolveAgentWorkspaceDir(result.config, "main", env)).toBe(path.join(home, "x", "main"));
  });

  it("falls back to the resolved path when the authored root does not match", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      authoredDefaultWorkspace: "${UNSET_WORKSPACE_ROOT}",
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
  });

  it("pins the agent directory when only it holds the agent's files", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
    expect(result.changes).toHaveLength(1);
  });

  it("pins the launch workspace without a shared root, copying the agent directory's files into it", async () => {
    const cfg = convergedRoster();
    delete cfg.agents!.defaults!.workspace;
    const launchDir = resolveDefaultAgentWorkspaceDir(testState.env);
    const agentDir = resolveAgentWorkspaceDir(cfg, "main", testState.env);
    await writePersona(launchDir, "launch persona");
    await fs.mkdir(path.join(agentDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "memory", "dream.md"), "later note");
    expect(agentDir).not.toBe(launchDir);

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(result.config.agents?.entries?.main?.workspace).toBe(launchDir);
    expect(await fs.readFile(path.join(launchDir, "SOUL.md"), "utf8")).toBe("launch persona");
    expect(await fs.readFile(path.join(launchDir, "memory", "dream.md"), "utf8")).toBe(
      "later note",
    );
  });

  it("warns without pinning when another agent owns the launch workspace and no root is set", async () => {
    const cfg = convergedRoster();
    delete cfg.agents!.defaults!.workspace;
    const launchDir = resolveDefaultAgentWorkspaceDir(testState.env);
    cfg.agents!.entries!.dev = { workspace: launchDir };

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(result.config).toBe(cfg);
    expect(result.warnings).toEqual([expect.stringContaining("which another agent owns")]);
  });

  it("keeps the agent's own customized files when both directories hold files", async () => {
    const agentDir = path.join(root, "main");
    await writePersona(root, "root persona");
    await writePersona(agentDir, "subdirectory persona");
    await fs.writeFile(path.join(root, "IDENTITY.md"), "root identity");
    await fs.writeFile(path.join(root, "memory", "same.md"), "same note");
    await fs.writeFile(path.join(agentDir, "memory", "same.md"), "same note");
    await fs.writeFile(path.join(root, "memory", "split.md"), "root note");
    await fs.writeFile(path.join(agentDir, "memory", "split.md"), "agent note");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.changes).toEqual([
      `Copied IDENTITY.md from ${root} into ${agentDir}; the files in ${root} stay in place.`,
      `Kept SOUL.md, ${path.join("memory", "split.md")} in ${agentDir}; the different copies in ${root} stay in place.`,
      `Set agents.entries.main.workspace to ${agentDir} so its working directory, persona, and memory use one workspace.`,
    ]);
    expect(await fs.readFile(path.join(agentDir, "IDENTITY.md"), "utf8")).toBe("root identity");
    expect(await fs.readFile(path.join(agentDir, "SOUL.md"), "utf8")).toBe("subdirectory persona");
    expect(await fs.readFile(path.join(agentDir, "memory", "split.md"), "utf8")).toBe("agent note");
    expect(await fs.readFile(path.join(root, "memory", "split.md"), "utf8")).toBe("root note");
  });

  it("warns without pinning when the agent's files cannot be copied", async () => {
    const agentDir = path.join(root, "main");
    await writePersona(root, "root persona");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.chmod(agentDir, 0o500);
    const cfg = convergedRoster();

    try {
      const result = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          `Could not copy the files of agent "main" from ${root} into ${agentDir}`,
        ),
      ]);
      await expect(fs.access(path.join(agentDir, "SOUL.md"))).rejects.toThrow();
    } finally {
      await fs.chmod(agentDir, 0o700);
    }
  });

  it("keeps the system agent off a shared root another agent already owns", async () => {
    await writePersona(root, "main persona");
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: root, systemAgent: { agentId: "ops" } },
        entries: { main: { workspace: root }, ops: {} },
      },
    } as OpenClawConfig;

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.config.agents?.entries?.ops?.workspace).toBe(path.join(root, "ops"));
    expect(result.config.agents?.entries?.main?.workspace).toBe(root);
  });

  it("warns instead of writing when the roster lives in an include", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env, {
      includeOwnsRoster: true,
    });

    expect(result).toEqual({
      config: cfg,
      changes: [],
      warnings: [expect.stringContaining("in the included agent roster")],
    });
  });

  it("warns instead of failing Doctor when a workspace cannot be read", async () => {
    const notADirectory = testState.path("not-a-directory");
    await fs.writeFile(notADirectory, "file");
    const cfg = convergedRoster();
    cfg.agents!.defaults!.workspace = notADirectory;

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('Could not inspect the workspaces of agent "main"'),
    ]);
  });

  it("leaves an authored workspace and a sole agent alone", async () => {
    await writePersona(root, "root persona");
    const pinned = convergedRoster({ workspace: path.join(root, "main") });
    const sole = {
      agents: { defaults: { workspace: root }, entries: { main: {} } },
    } as OpenClawConfig;

    expect(await repairSystemAgentWorkspacePin(pinned, testState.env)).toEqual({
      config: pinned,
      changes: [],
    });
    expect(await repairSystemAgentWorkspacePin(sole, testState.env)).toEqual({
      config: sole,
      changes: [],
    });
  });
});
