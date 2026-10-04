// System agent workspace repair tests cover which directory Doctor pins for a converged roster.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope-config.js";
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
  it("pins the shared root when only it holds the agent's files", async () => {
    await writePersona(root, "root persona");
    await ensureAgentWorkspace({ dir: path.join(root, "main"), ensureBootstrapFiles: true });
    const cfg = convergedRoster();
    expect(resolveAgentWorkspaceDir(cfg, "main")).toBe(path.join(root, "main"));

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(root);
    expect(resolveAgentWorkspaceDir(result.config, "main")).toBe(root);
    expect(resolveAgentWorkspaceDir(result.config, "dev")).toBe(path.join(root, "dev"));
    expect(result.changes).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "SOUL.md"), "utf8")).toBe("root persona");
  });

  it("pins the agent directory when only it holds the agent's files", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
    expect(result.changes).toHaveLength(1);
  });

  it("pins the directory its persona already resolves to when neither holds files", async () => {
    await ensureAgentWorkspace({ dir: root, ensureBootstrapFiles: true });

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
  });

  it("warns without choosing when both directories hold files", async () => {
    await writePersona(root, "root persona");
    await writePersona(path.join(root, "main"), "subdirectory persona");
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("set agents.entries.main.workspace to the directory to keep"),
    ]);
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
    await writePersona(root, "root persona");
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
