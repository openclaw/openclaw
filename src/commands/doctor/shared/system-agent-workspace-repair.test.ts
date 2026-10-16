// System agent workspace repair tests cover which directory Doctor pins for a converged roster.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope-config.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../../../agents/cli-session.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../../../agents/command/claude-cli-project-dir.js";
import { ensureAgentWorkspace } from "../../../agents/workspace.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { repairSystemAgentWorkspacePin } from "./system-agent-workspace-repair.js";

const patchFailure = vi.hoisted(() => ({ sessionKey: "" }));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    patchSessionEntryCore: async (
      ...args: Parameters<typeof actual.patchSessionEntryCore>
    ): ReturnType<typeof actual.patchSessionEntryCore> => {
      if (args[0].sessionKey === patchFailure.sessionKey) {
        throw new Error("session store is locked");
      }
      return await actual.patchSessionEntryCore(...args);
    },
  };
});

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
  patchFailure.sessionKey = "";
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

  it("recreates a linked skill when the root holds nothing else of the agent's", async () => {
    const agentDir = path.join(root, "main");
    const shared = testState.path("shared-skills");
    await fs.mkdir(path.join(shared, "deploy"), { recursive: true });
    await fs.writeFile(path.join(shared, "deploy", "SKILL.md"), "linked skill");
    await ensureAgentWorkspace({ dir: root, ensureBootstrapFiles: true });
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.symlink(path.join(shared, "deploy"), path.join(root, "skills", "deploy"));

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.changes[0]).toBe(
      `Copied ${path.join("skills", "deploy")} from ${root} into ${agentDir}; the files in ${root} stay in place.`,
    );
    expect(await fs.readFile(path.join(agentDir, "skills", "deploy", "SKILL.md"), "utf8")).toBe(
      "linked skill",
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

  it("warns instead of pinning when a stored CLI-backend conversation would lose its history", async () => {
    await writePersona(path.join(root, "main"), "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: { "claude-cli": { sessionId: "claude-native-1" } },
    });
    await storeSession("main", "agent:main:telegram:direct:1", {
      cliSessionIds: { "codex-cli": "codex-native-1" },
    });
    await storeSession("main", "agent:main:cron:nightly", { claudeCliSessionId: "legacy-1" });
    await storeSession("main", "agent:main:webchat:direct:2", { model: "gpt-5.4" });
    // The Claude CLI transcripts exist, so only the Codex CLI conversation blocks the pin.
    const source = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: root,
      homeDir: testState.env.HOME,
    });
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "claude-native-1.jsonl"), "native transcript\n");
    await fs.writeFile(path.join(source, "legacy-1.jsonl"), "legacy transcript\n");
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env);

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.explicitSetPaths).toBeUndefined();
    expect(result.warnings).toEqual([
      `Agent "main" works in ${root} but resolves its persona and memory to ${path.join(root, "main")}. Doctor did not set agents.entries.main.workspace because 1 stored CLI-backend conversation of this agent would start fresh, without resuming history, once its working directory changes. Set agents.entries.main.workspace to ${path.join(root, "main")} when that is acceptable.`,
    ]);
  });

  it("carries stored Claude CLI conversations to the pinned directory", async () => {
    const agentDir = path.join(root, "main");
    const home = testState.env.HOME;
    expect(home).toBeTruthy();
    const project = (dir: string) =>
      resolveClaudeCliProjectDirForWorkspace({ workspaceDir: dir, homeDir: home });
    await writePersona(agentDir, "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-native-1", cwdHash: hashCliSessionText(root) },
      },
    });
    await storeSession("main", "agent:main:cron:nightly", { claudeCliSessionId: "legacy-1" });
    await fs.mkdir(path.join(project(root), "claude-native-1", "tool-results"), {
      recursive: true,
    });
    await fs.writeFile(path.join(project(root), "claude-native-1.jsonl"), "native transcript\n");
    await fs.writeFile(path.join(project(root), "claude-native-1", "tool-results", "r.txt"), "r");
    await fs.writeFile(path.join(project(root), "legacy-1.jsonl"), "legacy transcript\n");
    const readBinding = () =>
      loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: testState.env }),
        env: testState.env,
      })?.cliSessionBindings?.["claude-cli"];

    const planned = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env);

    expect(planned.config.agents?.entries?.main?.workspace).toBeUndefined();
    expect(planned.changes[1]).toMatch(/^Carry 2 stored Claude CLI conversations of agent "main"/);
    await expect(fs.access(project(agentDir))).rejects.toThrow();
    expect(readBinding()?.cwdHash).toBe(hashCliSessionText(root));

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.warnings).toBeUndefined();
    expect(result.changes).toEqual([
      `Set agents.entries.main.workspace to ${agentDir} so its working directory, persona, and memory use one workspace.`,
      `Carried 2 stored Claude CLI conversations of agent "main" to ${agentDir}: their transcripts are copied into that directory's Claude project folder, the originals stay in place, and the next turn resumes with their history.`,
    ]);
    expect(await fs.readFile(path.join(project(agentDir), "claude-native-1.jsonl"), "utf8")).toBe(
      "native transcript\n",
    );
    expect(
      await fs.readFile(
        path.join(project(agentDir), "claude-native-1", "tool-results", "r.txt"),
        "utf8",
      ),
    ).toBe("r");
    expect(await fs.readFile(path.join(project(agentDir), "legacy-1.jsonl"), "utf8")).toBe(
      "legacy transcript\n",
    );
    expect(await fs.readFile(path.join(project(root), "claude-native-1.jsonl"), "utf8")).toBe(
      "native transcript\n",
    );
    const binding = readBinding();
    expect(binding?.sessionId).toBe("claude-native-1");
    expect(binding).not.toHaveProperty("cwdHash");
    // Both directories now hold the transcript: the binding resumes from the pinned directory, and
    // from the root too when the config write that would publish the pin is refused.
    for (const dir of [agentDir, root]) {
      expect(
        resolveCliSessionReuse({
          binding,
          authEpochVersion: 1,
          cwdHash: hashCliSessionText(dir),
        }),
      ).toEqual({ mode: "reuse", sessionId: "claude-native-1" });
    }
  });

  it("refreshes an earlier copy the conversation has grown past, and refuses a diverged one", async () => {
    const agentDir = path.join(root, "main");
    const project = (dir: string) =>
      resolveClaudeCliProjectDirForWorkspace({ workspaceDir: dir, homeDir: testState.env.HOME });
    await writePersona(agentDir, "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-native-1", cwdHash: hashCliSessionText(root) },
      },
    });
    await fs.mkdir(project(root), { recursive: true });
    await fs.mkdir(project(agentDir), { recursive: true });
    await fs.writeFile(path.join(project(root), "claude-native-1.jsonl"), "turn 1\nturn 2\n");
    await fs.writeFile(path.join(project(agentDir), "claude-native-1.jsonl"), "turn 1\n");

    const refreshed = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(refreshed.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(await fs.readFile(path.join(project(agentDir), "claude-native-1.jsonl"), "utf8")).toBe(
      "turn 1\nturn 2\n",
    );

    await storeSession("main", "agent:main:main", {
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-native-1", cwdHash: hashCliSessionText(root) },
      },
    });
    await fs.writeFile(path.join(project(agentDir), "claude-native-1.jsonl"), "turn 1\nother\n");
    const cfg = convergedRoster();

    const diverged = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(diverged.config).toBe(cfg);
    expect(diverged.warnings).toEqual([
      expect.stringContaining(
        "because 1 stored CLI-backend conversation of this agent would start fresh",
      ),
    ]);
    expect(await fs.readFile(path.join(project(agentDir), "claude-native-1.jsonl"), "utf8")).toBe(
      "turn 1\nother\n",
    );
  });

  it("warns instead of failing on an unreadable transcript, and never writes through a linked copy", async () => {
    const agentDir = path.join(root, "main");
    const project = (dir: string) =>
      resolveClaudeCliProjectDirForWorkspace({ workspaceDir: dir, homeDir: testState.env.HOME });
    await writePersona(agentDir, "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-native-1", cwdHash: hashCliSessionText(root) },
      },
    });
    await fs.mkdir(project(root), { recursive: true });
    await fs.mkdir(project(agentDir), { recursive: true });
    await fs.writeFile(path.join(project(root), "claude-native-1.jsonl"), "turn 1\nturn 2\n");
    const cfg = convergedRoster();
    const stuckWarning = expect.stringContaining(
      "because 1 stored CLI-backend conversation of this agent would start fresh",
    );

    await fs.chmod(project(root), 0o000);
    try {
      const unreadable = await repairSystemAgentWorkspacePin(cfg, testState.env, {
        applyFiles: true,
      });

      expect(unreadable.config).toBe(cfg);
      expect(unreadable.warnings).toEqual([stuckWarning]);
    } finally {
      await fs.chmod(project(root), 0o700);
    }

    const elsewhere = path.join(root, "elsewhere.jsonl");
    await fs.writeFile(elsewhere, "turn 1\n");
    await fs.symlink(elsewhere, path.join(project(agentDir), "claude-native-1.jsonl"));

    const linked = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(linked.config).toBe(cfg);
    expect(linked.warnings).toEqual([stuckWarning]);
    expect(await fs.readFile(elsewhere, "utf8")).toBe("turn 1\n");

    const outside = path.join(root, "outside-results");
    await fs.rm(path.join(project(agentDir), "claude-native-1.jsonl"));
    await fs.mkdir(path.join(project(root), "claude-native-1"), { recursive: true });
    await fs.writeFile(path.join(project(root), "claude-native-1", "tool.txt"), "result");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(project(agentDir), "claude-native-1"));

    const linkedResults = await repairSystemAgentWorkspacePin(cfg, testState.env, {
      applyFiles: true,
    });

    expect(linkedResults.config).toBe(cfg);
    expect(linkedResults.warnings).toEqual([
      expect.stringContaining("would be written through a link"),
    ]);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("pins without carrying a conversation the root would not resume", async () => {
    const agentDir = path.join(root, "main");
    const binding = {
      sessionId: "claude-native-1",
      cwdHash: hashCliSessionText(path.join(root, "elsewhere")),
    };
    await writePersona(agentDir, "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: { "claude-cli": binding },
    });

    const result = await repairSystemAgentWorkspacePin(convergedRoster(), testState.env, {
      applyFiles: true,
    });

    expect(result.config.agents?.entries?.main?.workspace).toBe(agentDir);
    expect(result.changes).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Claude CLI conversation")]),
    );
    expect(
      loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: testState.env }),
        env: testState.env,
      })?.cliSessionBindings?.["claude-cli"],
    ).toEqual(binding);
  });

  it("warns without pinning when a Claude CLI conversation cannot be carried", async () => {
    const agentDir = path.join(root, "main");
    const projects = path.join(testState.env.HOME ?? "", ".claude", "projects");
    await writePersona(agentDir, "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-native-1", cwdHash: hashCliSessionText(root) },
      },
    });
    const source = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: root,
      homeDir: testState.env.HOME,
    });
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "claude-native-1.jsonl"), "native transcript\n");
    await fs.chmod(projects, 0o500);
    const cfg = convergedRoster();

    try {
      const result = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          `Could not carry the stored Claude CLI conversations of agent "main" to ${agentDir}`,
        ),
      ]);
    } finally {
      await fs.chmod(projects, 0o700);
    }
  });

  it("keeps every binding resumable in the root when a later binding cannot be updated", async () => {
    const agentDir = path.join(root, "main");
    const storePath = resolveSessionStorePathCore(undefined, {
      agentId: "main",
      env: testState.env,
    });
    const source = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: root,
      homeDir: testState.env.HOME,
    });
    await writePersona(agentDir, "subdirectory persona");
    await fs.mkdir(source, { recursive: true });
    for (const { sessionKey, sessionId } of [
      { sessionKey: "agent:main:main", sessionId: "claude-native-1" },
      { sessionKey: "agent:main:cron:nightly", sessionId: "claude-native-2" },
    ]) {
      await storeSession("main", sessionKey, {
        cliSessionBindings: { "claude-cli": { sessionId, cwdHash: hashCliSessionText(root) } },
      });
      await fs.writeFile(path.join(source, `${sessionId}.jsonl`), `${sessionId} transcript\n`);
    }
    const conversation = (sessionKey: string, sessionId: string) => ({
      scope: { agentId: "main", env: testState.env, storePath, sessionKey },
      providers: ["claude-cli"],
      claudeSessionIds: [sessionId],
      legacyStore: false,
    });
    patchFailure.sessionKey = "agent:main:cron:nightly";
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env, {
      applyFiles: true,
      listCliConversations: () => [
        conversation("agent:main:main", "claude-native-1"),
        conversation("agent:main:cron:nightly", "claude-native-2"),
      ],
    });

    expect(result.config).toBe(cfg);
    expect(result.warnings).toEqual([
      `Could not carry the stored Claude CLI conversations of agent "main" to ${agentDir}: session store is locked. Doctor did not set agents.entries.main.workspace.`,
    ]);
    // The first binding no longer records a directory, the second still records the root: both
    // resume in the root, where the agent keeps working without the pin.
    for (const sessionKey of ["agent:main:main", "agent:main:cron:nightly"]) {
      const binding = loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey,
        storePath,
        env: testState.env,
      })?.cliSessionBindings?.["claude-cli"];
      expect(
        resolveCliSessionReuse({
          binding,
          authEpochVersion: 1,
          cwdHash: hashCliSessionText(root),
        }).mode,
      ).toBe("reuse");
    }
  });

  it("warns without pinning when a Claude CLI transcript is missing from the launch folder", async () => {
    const agentDir = path.join(root, "main");
    await writePersona(agentDir, "subdirectory persona");
    await storeSession("main", "agent:main:main", {
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-native-1", cwdHash: hashCliSessionText(root) },
      },
    });
    const cfg = convergedRoster();

    const result = await repairSystemAgentWorkspacePin(cfg, testState.env, { applyFiles: true });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Doctor did not set agents.entries.main.workspace because 1 stored CLI-backend conversation of this agent would start fresh",
      ),
    ]);
    await expect(
      fs.access(
        resolveClaudeCliProjectDirForWorkspace({
          workspaceDir: agentDir,
          homeDir: testState.env.HOME,
        }),
      ),
    ).rejects.toThrow();
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
      listCliConversations: () => {
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
      listCliConversations: (agentId) =>
        agentId === "main"
          ? [
              {
                scope: {
                  agentId,
                  env: testState.env,
                  storePath: "unused",
                  sessionKey: "agent:main:main",
                },
                providers: ["codex-cli"],
                claudeSessionIds: [],
                legacyStore: false,
              },
            ]
          : [],
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings?.[0]).toContain(
      "because 1 stored CLI-backend conversation of this agent",
    );
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
