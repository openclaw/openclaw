// System agent workspace repair tests cover which directory Doctor pins for a converged roster.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope-config.js";
import { ensureAgentWorkspace } from "../../../agents/workspace.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
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

async function storeSession(agentId: string, sessionKey: string, patch: Partial<SessionEntry>) {
  await upsertSessionEntryCore(
    {
      agentId,
      sessionKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId, env: testState.env }),
    },
    { sessionId: `${agentId}-local`, updatedAt: Date.now(), ...patch },
  );
}

async function writePersona(dir: string, soul: string) {
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, "SOUL.md"), soul);
}

describe("repairSystemAgentWorkspacePin", () => {
  it("warns without pinning when only the shared root holds the agent's files", async () => {
    await writePersona(root, "root persona");
    await ensureAgentWorkspace({ dir: path.join(root, "main"), ensureBootstrapFiles: true });
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.explicitSetPaths).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain(root);
    expect(result.warnings?.[0]).toContain(path.join(root, "main"));
    expect(result.warnings?.[0]).toContain("agents.entries.main.workspace");
    expect(await fs.readFile(path.join(root, "SOUL.md"), "utf8")).toBe("root persona");
  });

  it("counts a customized AGENTS.md as files in either directory", async () => {
    await fs.writeFile(path.join(root, "SOUL.md"), "root persona");
    await fs.mkdir(path.join(root, "main"), { recursive: true });
    await fs.writeFile(path.join(root, "main", "AGENTS.md"), "customized agent rules");
    const cfg = convergedRoster();

    const both = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(both.config).toBe(cfg);
    expect(both.changes).toEqual([]);
    expect(both.warnings).toEqual([
      expect.stringContaining("set agents.entries.main.workspace to the directory to keep"),
    ]);
    expect(both.warnings?.[0]).toContain(root);
    expect(both.warnings?.[0]).toContain(path.join(root, "main"));

    await fs.rm(path.join(root, "SOUL.md"));
    await fs.writeFile(path.join(root, "AGENTS.md"), "customized root rules");
    await fs.rm(path.join(root, "main", "AGENTS.md"));
    const rootOnly = await repairSystemAgentWorkspacePin(cfg, testState.env);
    expect(rootOnly.changes).toEqual([]);
    expect(rootOnly.warnings).toHaveLength(1);
  });

  it("pins the agent directory when only its AGENTS.md is customized", async () => {
    await fs.mkdir(path.join(root, "main"), { recursive: true });
    await fs.writeFile(path.join(root, "main", "AGENTS.md"), "customized agent rules");

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
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

  it("pins the directory its persona already resolves to when neither holds files", async () => {
    await ensureAgentWorkspace({ dir: root, ensureBootstrapFiles: true });

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
  });

  it("warns instead of pinning when a stored CLI-backend conversation would restart", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: { "claude-cli": { sessionId: "claude-native-1" } },
    });
    await storeSession("main", "agent:main:telegram:direct:1", {
      cliSessionIds: { "codex-cli": "codex-native-1" },
    });
    await storeSession("main", "agent:main:cron:nightly", { claudeCliSessionId: "legacy-1" });
    await storeSession("main", "agent:main:webchat:direct:2", { model: "gpt-5.4" });
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.explicitSetPaths).toBeUndefined();
    expect(result.warnings).toEqual([
      `Agent "main" works in ${root} but resolves its persona and memory to ${path.join(root, "main")}. Doctor did not set agents.entries.main.workspace because 3 stored CLI-backend conversations of this agent would start fresh, without resuming history, once its working directory changes. Set agents.entries.main.workspace to ${path.join(root, "main")} when that is acceptable.`,
    ]);
  });

  it("pins when only another agent or no session holds a CLI-backend conversation", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");
    await storeSession("dev", "agent:dev:main", {
      cliSessionBindings: { "claude-cli": { sessionId: "claude-native-dev" } },
    });
    await storeSession("main", "agent:main:main", { model: "gpt-5.4", cliSessionBindings: {} });

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.config.agents?.entries?.main?.workspace).toBe(path.join(root, "main"));
    expect(result.warnings).toBeUndefined();
  });

  it("counts a CLI-backend conversation kept in a legacy session store", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");
    const legacyStorePath = resolveSessionStorePathCore(undefined, {
      agentId: "main",
      env: testState.env,
    });
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "main-local",
          updatedAt: Date.now(),
          cliSessionBindings: { "claude-cli": { sessionId: "claude-native-legacy" } },
        },
      }),
    );

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(result.changes).toEqual([]);
    expect(result.warnings?.[0]).toContain(
      "because 1 stored CLI-backend conversation of this agent",
    );
  });

  it("names the pin it skipped when stored sessions cannot be read", async () => {
    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      countCliConversations: () => {
        throw new Error("database is locked");
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      `Could not read the stored sessions of agent "main": database is locked. Doctor did not set agents.entries.main.workspace; set it to ${path.join(root, "main")} so its working directory, persona, and memory use one workspace.`,
    ]);
  });

  it("counts one stored CLI-backend conversation in the singular", async () => {
    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      countCliConversations: (agentId) => (agentId === "main" ? 1 : 0),
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings?.[0]).toContain(
      "because 1 stored CLI-backend conversation of this agent",
    );
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
