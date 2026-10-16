import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { runAgentEndSideEffectsAsync } from "../agents/harness/agent-end-side-effects.js";
import { createReadTool } from "../agents/sessions/tools/read.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import * as admission from "../process/gateway-work-admission.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const DAY = 24 * 60 * 60_000;
afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
  admission.resetGatewayWorkAdmission();
});

async function dispatch(config: OpenClawConfig, method: string, params: Record<string, unknown>) {
  const respond = vi.fn<GatewayRequestOptions["respond"]>();
  await handleGatewayRequest({
    req: { type: "req", id: "maintenance-contract", method, params },
    client: {
      connId: "maintenance-contract",
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestOptions["context"],
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  const response = respond.mock.calls[0];
  assert.isDefined(response);
  const [ok, payload, error] = response;
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  return payload;
}

it("L6/Y1/Y2: Gateway usage protects read skills, and post-turn cleanup is daily, versioned and cron-aware", async () => {
  const state = await createOpenClawTestState({ prefix: "workshop-maintenance-contract-" });
  const agentId = "maintenance-contract";
  const otherAgentId = "maintenance-other";
  const otherFile = path.join(
    state.agentDir(otherAgentId),
    "workshop-skills",
    "other-stale",
    "SKILL.md",
  );
  const root = path.join(state.agentDir(agentId), "workshop-skills");
  const config: OpenClawConfig = {
    agents: {
      entries: {
        [agentId]: { agentDir: state.agentDir(agentId), workspace: state.workspaceDir },
        [otherAgentId]: { agentDir: state.agentDir(otherAgentId), workspace: state.workspaceDir },
      },
      defaults: {
        model: "anthropic/claude-test",
        models: { "anthropic/*": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
  const birth = Date.now();
  const now = birth + 31 * DAY;
  async function seed(name: string, mtime = birth) {
    const file = path.join(root, name, "SKILL.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `---\nname: ${name}\ndescription: ${name} procedure\n---\n\nRetain the receipt for ${name}.\n`,
    );
    await fs.utimes(file, new Date(mtime), new Date(mtime));
    return file;
  }
  let timers:
    | { stopPeriodicTasks: () => Promise<void>; skillUsageCleanup: () => Promise<void> }
    | undefined;
  const start = () =>
    startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      getRuntimeConfig: () => config,
      runWorktreeGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });
  // Observe the real returned lifetime without replacing the detached work implementation.
  const detached = vi.spyOn(admission, "runWithGatewayDetachedWorkContinuation");
  async function finishTurn(cfg = config, targetAgentId = agentId) {
    const before = detached.mock.results.length;
    setRuntimeConfigSnapshot(cfg);
    await runAgentEndSideEffectsAsync({
      event: { messages: [], success: true },
      ctx: {
        config: cfg,
        runId: "maintenance-turn",
        sessionKey: `agent:${targetAgentId}:main`,
        workspaceDir: state.workspaceDir,
        trigger: "user",
        foregroundPromptContext: {
          agentId: targetAgentId,
          agentDir: state.agentDir(targetAgentId),
          workspaceDir: state.workspaceDir,
          sandboxSessionKey: `agent:${targetAgentId}:main`,
          trigger: "user",
        },
      },
    });
    for (const result of detached.mock.results.slice(before)) {
      if (result.type === "return") {
        await result.value;
      }
    }
  }
  try {
    await state.writeConfig(config);
    for (const name of ["stale", "used", "cron-protected", "changed", "fresh-file"]) {
      await seed(name, name === "fresh-file" ? now : birth);
    }
    await fs.mkdir(path.dirname(otherFile), { recursive: true });
    await fs.writeFile(
      otherFile,
      "---\nname: other-stale\ndescription: Other agent procedure\n---\nKeep receipts.\n",
    );
    await fs.utimes(otherFile, new Date(birth), new Date(birth));
    const databasePath = openOpenClawStateDatabase().path;
    await closeStateDatabaseForTest();
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
      db.prepare(
        "INSERT INTO skill_workshop_changes (cursor_id, change_id, agent_id, skill_name, action, actor, summary, created_at_ms) VALUES (1, 'recent-change', ?, 'changed', 'patch', 'agent', 'recent update', ?)",
      ).run(agentId, now - DAY);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await saveCronJobsStore(resolveCronJobsStorePath(), {
      version: 1,
      jobs: [
        makeCronJob({
          enabled: false,
          payload: {
            kind: "agentTurn",
            message: "Use cron-protected when the quarterly job resumes.",
          },
        }),
      ],
    });
    // Advancing only Date makes real on-disk ctime old too, without mocking fs.stat.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    setRuntimeConfigSnapshot(config);
    timers = start();
    const snapshot = await buildSkillSnapshot(state.workspaceDir, { config, agentId });
    const read = wrapToolWithBeforeToolCallHook(createReadTool(state.workspaceDir), {
      agentId,
      sessionKey: `agent:${agentId}:main`,
      runId: "usage-contract",
      workspaceDir: state.workspaceDir,
      skillsSnapshot: snapshot,
      loopDetection: { enabled: false },
    });
    const result = await read.execute("read-used", { path: path.join(root, "used", "SKILL.md") });
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Retain the receipt for used."),
      }),
    );
    await nextTurn();
    // Disposal must flush accepted usage before the RPC reads the database.
    await timers.skillUsageCleanup();
    expect(await dispatch(config, "skills.workshop.list", { agentId })).toMatchObject({
      mode: "auto",
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "used", useCount: 1, lastUsedAtMs: now }),
      ]),
    });
    await timers.stopPeriodicTasks();
    timers = start();
    await finishTurn({
      ...config,
      skills: { ...config.skills, workshop: { autonomous: { mode: "off" } } },
    });
    expect(await fs.readFile(path.join(root, "stale", "SKILL.md"), "utf8")).toContain(
      "stale procedure",
    );
    await finishTurn();
    await expect(fs.stat(path.join(root, "stale"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of ["used", "cron-protected", "changed", "fresh-file"]) {
      expect(await fs.readFile(path.join(root, name, "SKILL.md"), "utf8")).toContain(
        `${name} procedure`,
      );
    }
    expect(await dispatch(config, "skills.workshop.changes", { agentId })).toMatchObject({
      changes: expect.arrayContaining([
        expect.objectContaining({
          skillName: "stale",
          action: "archive",
          actor: "curator",
          summary: "archived: unused for 30 days",
        }),
      ]),
    });
    const versions = await fs.readdir(path.join(root, ".archive", "stale"));
    expect(versions).toHaveLength(1);
    const version = versions[0];
    assert.isDefined(version);
    expect(
      await fs.readFile(path.join(root, ".archive", "stale", version, "SKILL.md"), "utf8"),
    ).toContain("stale procedure");
    await finishTurn(config, otherAgentId);
    await expect(fs.stat(otherFile)).rejects.toMatchObject({ code: "ENOENT" });
    await seed("next-pass");
    await finishTurn();
    expect(await fs.readFile(path.join(root, "next-pass", "SKILL.md"), "utf8")).toContain(
      "next-pass procedure",
    );
    vi.setSystemTime(now + DAY);
    await finishTurn();
    await expect(fs.stat(path.join(root, "next-pass"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await timers?.stopPeriodicTasks();
    await timers?.skillUsageCleanup();
    await closeSkillsWatchers(true);
    vi.useRealTimers();
    await state.cleanup();
  }
});

it.each(["untracked", "sandboxed", "native-runtime", "learning-off"] as const)(
  "Y2: post-turn cleanup keeps old skills when %s",
  async (reason) => {
    const state = await createOpenClawTestState({ prefix: "workshop-cleanup-guard-" });
    const agentId = `guard-${reason}`;
    const file = path.join(state.agentDir(agentId), "workshop-skills", "keep", "SKILL.md");
    const config: OpenClawConfig = {
      agents: {
        entries: {
          [agentId]: { agentDir: state.agentDir(agentId), workspace: state.workspaceDir },
        },
        defaults: {
          model: "anthropic/claude-test",
          models: {
            "anthropic/*": {
              agentRuntime: { id: reason === "native-runtime" ? "codex" : "openclaw" },
            },
          },
          ...(reason === "sandboxed" ? { sandbox: { mode: "all" as const } } : {}),
        },
      },
      plugins: { enabled: false },
      skills: { load: { watch: false }, workshop: { autonomous: { mode: "auto" } } },
    };
    let timers:
      | { stopPeriodicTasks: () => Promise<void>; skillUsageCleanup: () => Promise<void> }
      | undefined;
    const detached = vi.spyOn(admission, "runWithGatewayDetachedWorkContinuation");
    try {
      await state.writeConfig(config);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const content = "---\nname: keep\ndescription: Keep this old procedure\n---\nInstructions.\n";
      await fs.writeFile(file, content);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31 * DAY);
      setRuntimeConfigSnapshot(
        reason === "learning-off"
          ? { ...config, skills: { ...config.skills, workshop: { autonomous: { mode: "off" } } } }
          : config,
      );
      if (reason !== "untracked") {
        timers = startGatewayMaintenanceTimers({
          ...createGatewayMaintenanceStateForTest(),
          getRuntimeConfig: () => config,
          runWorktreeGc: async () => undefined,
          runManagedOutgoingMediaGc: async () => undefined,
        });
      }
      await runAgentEndSideEffectsAsync({
        event: { messages: [], success: true },
        ctx: {
          config,
          runId: agentId,
          sessionKey: `agent:${agentId}:main`,
          workspaceDir: state.workspaceDir,
          foregroundPromptContext: {
            agentId,
            agentDir: state.agentDir(agentId),
            workspaceDir: state.workspaceDir,
            sandboxSessionKey: `agent:${agentId}:main`,
            trigger: "user",
          },
        },
      });
      for (const result of detached.mock.results) {
        if (result.type === "return") {
          await result.value;
        }
      }
      expect(await fs.readFile(file, "utf8")).toBe(content);
      await expect(
        fs.stat(path.join(path.dirname(path.dirname(file)), ".archive")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await timers?.stopPeriodicTasks();
      await timers?.skillUsageCleanup();
      vi.useRealTimers();
      await state.cleanup();
    }
  },
);
