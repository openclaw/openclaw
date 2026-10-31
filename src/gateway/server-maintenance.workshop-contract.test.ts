import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { text as readText } from "node:stream/consumers";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { runAgentEndSideEffectsAsync } from "../agents/harness/agent-end-side-effects.js";
import { createReadTool } from "../agents/sessions/tools/read.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
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
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

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
    plugins: { allow: ["skill-workshop"] },
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

it.each([
  "untracked",
  "sandboxed",
  "native-runtime",
  "learning-off",
  "learning-propose",
  "tool-denied",
] as const)("Y2: post-turn cleanup keeps old skills when %s", async (reason) => {
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
    ...(reason === "tool-denied" ? { tools: { deny: ["skill_workshop"] } } : {}),
    plugins: { allow: ["skill-workshop"] },
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
      reason === "learning-off" || reason === "learning-propose"
        ? {
            ...config,
            skills: {
              ...config.skills,
              workshop: { autonomous: { mode: reason === "learning-off" ? "off" : "propose" } },
            },
          }
        : config,
    );
    if (reason !== "untracked") {
      timers = startGatewayMaintenanceTimers({
        ...createGatewayMaintenanceStateForTest(),
        getRuntimeConfig: () => config,
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
});

it("Y3: daily maintenance diets one oversized learned skill as a restorable curator change", async () => {
  const state = await createOpenClawTestState({ prefix: "workshop-diet-contract-" });
  const agentId = "diet-contract";
  const root = path.join(state.agentDir(agentId), "workshop-skills");
  const file = path.join(root, "deploy", "SKILL.md");
  const filler = (label: string) =>
    `${label}: ${"Keep the staging lane exact before each supported release. ".repeat(80).trimEnd()}`;
  const original = [
    "---\nname: deploy\ndescription: Deploy staging builds\n---\n",
    "# Deploy\n\n## Procedure\n\n1. Build only from the exact tag.",
    filler("procedure"),
    "\n## Rollback\n",
    filler("rollback"),
    "\n## Rare case\n",
    filler("rare"),
    "",
  ].join("\n");
  const slim = [
    "# Deploy",
    "",
    "## Procedure",
    "",
    "1. Build only from the exact tag.",
    "",
    "## Look up the case",
    "",
    "- Rolling back, rare hosts → [branches](references/branches.md)",
  ].join("\n");
  const plan = JSON.stringify({
    skill: slim,
    references: [
      {
        file: "references/branches.md",
        title: "Deploy branches",
        readWhen: "Read when rolling back or on a rare host.",
        sections: ["Rollback", "Rare case"],
      },
    ],
  });
  const requests: string[] = [];
  let timers:
    | { stopPeriodicTasks: () => Promise<void>; skillUsageCleanup: () => Promise<void> }
    | undefined;
  const detached = vi.spyOn(admission, "runWithGatewayDetachedWorkContinuation");
  try {
    await withServer(
      (request, response) => {
        void readText(request).then((body) => {
          requests.push(body);
          // The reviewer gets a clean audit; the rewrite call gets the plan.
          const text = body.includes("strict reviewer") ? '{"findings":[]}' : plan;
          writeOpenAiResponsesText(response, {
            text,
            messageId: `diet_${requests.length}`,
            responseId: `diet_${requests.length}`,
          });
        });
      },
      async (baseUrl) => {
        const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "diet-contract");
        const config: OpenClawConfig = {
          agents: {
            entries: {
              [agentId]: { agentDir: state.agentDir(agentId), workspace: state.workspaceDir },
            },
            defaults: {
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          plugins: { allow: ["skill-workshop"] },
          skills: { load: { watch: false } },
        };
        await state.writeConfig(config);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, original);
        const settled = new Date(Date.now() - 2 * DAY);
        await fs.utimes(file, settled, settled);
        setRuntimeConfigSnapshot(config);
        timers = startGatewayMaintenanceTimers({
          ...createGatewayMaintenanceStateForTest(),
          getRuntimeConfig: () => config,
        });
        await runAgentEndSideEffectsAsync({
          event: { messages: [], success: true },
          ctx: {
            config,
            runId: "diet-turn",
            sessionKey: `agent:${agentId}:main`,
            workspaceDir: state.workspaceDir,
            trigger: "user",
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
        expect(requests).toHaveLength(2);
        expect(await fs.readFile(file, "utf8")).toBe(
          `---\nname: deploy\ndescription: Deploy staging builds\n---\n\n${slim}\n`,
        );
        const branches = await fs.readFile(
          path.join(root, "deploy", "references", "branches.md"),
          "utf8",
        );
        expect(branches).toContain(filler("rollback"));
        expect(branches).toContain(filler("rare"));
        const { changes } = (await dispatch(config, "skills.workshop.changes", { agentId })) as {
          changes: Array<{
            skillName: string;
            action: string;
            actor: string;
            summary: string;
            versionId?: string;
          }>;
        };
        expect(changes).toEqual([
          expect.objectContaining({
            skillName: "deploy",
            actor: "curator",
            summary: expect.stringMatching(/^diet: SKILL\.md /),
          }),
        ]);
        await dispatch(config, "skills.workshop.restore", {
          agentId,
          name: "deploy",
          versionId: changes[0]?.versionId,
        });
        expect(await fs.readFile(file, "utf8")).toBe(original);
        await expect(fs.stat(path.join(root, "deploy", "references"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  } finally {
    await timers?.stopPeriodicTasks();
    await timers?.skillUsageCleanup();
    await closeSkillsWatchers(true);
    await state.cleanup();
  }
});
