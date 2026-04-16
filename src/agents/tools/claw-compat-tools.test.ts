import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ feature: { verbose: false } })),
  writeConfigFile: vi.fn(async () => undefined),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: configMock.loadConfig,
  writeConfigFile: configMock.writeConfigFile,
}));

describe("claw compat tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("supports sleep duration_ms and enforces max duration", async () => {
    const { createSleepCompatTool } = await import("./claw-compat-tools.js");
    const tool = createSleepCompatTool();
    const result = await tool.execute("tool-1", { duration_ms: 0 });
    expect(result).toMatchObject({ details: { status: "ok", sleptMs: 0 } });
    await expect(tool.execute("tool-2", { duration_ms: 300_001 })).rejects.toThrow(
      "exceeds maximum allowed sleep",
    );
  });

  it("maps tool_search max_results and returns limited results", async () => {
    const { createToolSearchCompatTool } = await import("./claw-compat-tools.js");
    const tool = createToolSearchCompatTool();
    const result = await tool.execute("tool-3", { query: "task", max_results: 1 });
    expect(result).toMatchObject({
      details: {
        status: "ok",
        query: "task",
        tools: expect.any(Array),
      },
    });
    expect((result as { details: { tools: unknown[] } }).details.tools.length).toBeLessThanOrEqual(1);
  });

  it("supports config setting get/set payloads", async () => {
    const { createConfigCompatTool } = await import("./claw-compat-tools.js");
    const tool = createConfigCompatTool();

    const getResult = await tool.execute("tool-4", { setting: "feature.verbose" });
    expect(getResult).toMatchObject({
      details: {
        success: true,
        operation: "get",
        setting: "feature.verbose",
        value: false,
      },
    });

    const setResult = await tool.execute("tool-5", { setting: "feature.verbose", value: true });
    expect(setResult).toMatchObject({
      details: {
        success: true,
        operation: "set",
        setting: "feature.verbose",
        value: true,
      },
    });
    expect(configMock.writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("sends RemoteTrigger string body without JSON quoting", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "ok",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { createRemoteTriggerCompatTool } = await import("./claw-compat-tools.js");
      const tool = createRemoteTriggerCompatTool();
      await tool.execute("tool-6", {
        url: "https://example.com/webhook",
        method: "POST",
        body: "plain-body",
      });
      const call = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
      expect(call?.body).toBe("plain-body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns testing_permission compat payload", async () => {
    const { createTestingPermissionCompatTool } = await import("./claw-compat-tools.js");
    const tool = createTestingPermissionCompatTool();
    const result = await tool.execute("tool-7", { action: "probe" });
    expect(result).toMatchObject({
      details: {
        action: "probe",
        permitted: true,
        mode: "workspace-write",
      },
    });
  });

  it("maps ask_user_question answer from arguments and option indexes", async () => {
    const { createAskUserQuestionCompatTool } = await import("./claw-compat-tools.js");
    const tool = createAskUserQuestionCompatTool();
    const result = await tool.execute("tool-7b", {
      question: "Proceed?",
      options: ["yes", "no"],
      answer: "1",
    });
    expect(result).toMatchObject({
      details: {
        status: "answered",
        answer: "yes",
        source: "argument",
      },
    });
  });

  it("maps ask_user_question answer from env fallback", async () => {
    vi.stubEnv("OPENCLAW_ASK_USER_QUESTION_ANSWER", "2");
    const { createAskUserQuestionCompatTool } = await import("./claw-compat-tools.js");
    const tool = createAskUserQuestionCompatTool();
    const result = await tool.execute("tool-7c", {
      question: "Proceed?",
      options: ["yes", "no"],
    });
    expect(result).toMatchObject({
      details: {
        status: "answered",
        answer: "no",
        source: "env",
      },
    });
  });

  it("applies testing_permission denial on read-only mode for mutating actions", async () => {
    configMock.loadConfig.mockReturnValueOnce({ permissions: { defaultMode: "read-only" } });
    const { createTestingPermissionCompatTool } = await import("./claw-compat-tools.js");
    const tool = createTestingPermissionCompatTool();
    const result = await tool.execute("tool-7d", { action: "write_file", allow: true });
    expect(result).toMatchObject({
      details: {
        permitted: false,
        mode: "read-only",
        actionKind: "write",
        matchesExpected: false,
      },
    });
  });

  it("persists todo_write payload and returns old/new todo sets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-compat-"));
    const storePath = path.join(tempDir, "todos.json");
    vi.stubEnv("CLAWD_TODO_STORE", storePath);

    const { createTodoWriteCompatTool } = await import("./claw-compat-tools.js");
    const tool = createTodoWriteCompatTool();
    const first = await tool.execute("tool-8", {
      todos: [{ content: "Task A", activeForm: "Doing Task A", status: "in_progress" }],
    });
    expect(first).toMatchObject({
      details: {
        old_todos: [],
        new_todos: [{ content: "Task A", activeForm: "Doing Task A", status: "in_progress" }],
      },
    });

    const second = await tool.execute("tool-9", {
      todos: [{ content: "Task B", activeForm: "Done Task B", status: "completed" }],
    });
    expect(second).toMatchObject({
      details: {
        old_todos: [{ content: "Task A", activeForm: "Doing Task A", status: "in_progress", priority: null }],
      },
    });
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as unknown[];
    expect(persisted).toEqual([]);
  });

  it("rejects empty structured_output payload", async () => {
    const { createStructuredOutputCompatTool } = await import("./claw-compat-tools.js");
    const tool = createStructuredOutputCompatTool();
    await expect(tool.execute("tool-10", {})).rejects.toThrow("structured output payload must not be empty");
  });
});
