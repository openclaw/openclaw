import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getSessionPlanState,
  getSessionRuntimeMode,
  loadSessionStore,
} from "../../config/sessions.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.js";
import { getTaskById, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createTaskCreateTool,
  createTaskUpdateTool,
  createTodoWriteTool,
} from "./plan-mode-tools.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const SESSION_KEY = "agent:main:main";

function createTempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plan-mode-tools-"));
  return {
    root,
    cfg: {
      session: {
        store: path.join(root, "sessions.json"),
        mainKey: "main",
      },
    } as OpenClawConfig,
  };
}

describe("plan mode tools", () => {
  const tempDirs = new Set<string>();

  beforeEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("enters, persists, and exits plan mode", async () => {
    const { root, cfg } = createTempConfig();
    tempDirs.add(root);

    const enterPlanMode = createEnterPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const todoWrite = createTodoWriteTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const exitPlanMode = createExitPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });

    await enterPlanMode.execute("enter-plan", {});
    expect(getSessionRuntimeMode(SESSION_KEY, cfg)).toBe("plan");

    await todoWrite.execute("todo-write", {
      content: "1. Inspect\n2. Confirm",
      todos: [
        {
          id: "todo-1",
          text: "Inspect the affected files",
          status: "in_progress",
        },
      ],
    });

    expect(getSessionPlanState(SESSION_KEY, cfg)).toMatchObject({
      content: "1. Inspect\n2. Confirm",
      todos: [
        {
          id: "todo-1",
          text: "Inspect the affected files",
          status: "in_progress",
        },
      ],
    });

    await exitPlanMode.execute("exit-plan", {});

    const store = loadSessionStore(cfg.session!.store as string);
    expect(store[SESSION_KEY]).toMatchObject({
      runtimeMode: "normal",
      planState: {
        content: "1. Inspect\n2. Confirm",
      },
    });
    expect(store[SESSION_KEY]?.planState?.confirmedAt).toEqual(expect.any(Number));
  });

  it("creates and updates session-scoped tasks from persisted todos", async () => {
    const { root, cfg } = createTempConfig();
    tempDirs.add(root);
    process.env.OPENCLAW_STATE_DIR = root;

    const todoWrite = createTodoWriteTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const taskCreate = createTaskCreateTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const taskUpdate = createTaskUpdateTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });

    await todoWrite.execute("todo-write", {
      todos: [
        {
          id: "todo-1",
          text: "Run the landing verification",
          status: "pending",
        },
      ],
    });

    const created = await taskCreate.execute("task-create", {
      todoId: "todo-1",
      status: "queued",
    });
    const createdDetails = created.details as {
      task?: {
        taskId: string;
        status: string;
      };
    };
    expect(createdDetails.task?.status).toBe("queued");
    const taskId = createdDetails.task?.taskId;
    expect(taskId).toBeTruthy();
    if (!taskId) {
      throw new Error("missing created task id");
    }

    await taskUpdate.execute("task-update-running", {
      taskId,
      status: "running",
      progressSummary: "Verification started",
    });
    expect(getTaskById(taskId)).toMatchObject({
      status: "running",
      progressSummary: "Verification started",
      ownerKey: SESSION_KEY,
    });

    await taskUpdate.execute("task-update-done", {
      taskId,
      status: "succeeded",
      terminalSummary: "Verification passed",
      terminalOutcome: "succeeded",
    });
    expect(getTaskById(taskId)).toMatchObject({
      status: "succeeded",
      terminalSummary: "Verification passed",
      terminalOutcome: "succeeded",
    });
  });
});
