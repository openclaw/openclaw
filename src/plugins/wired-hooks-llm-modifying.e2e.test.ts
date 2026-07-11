/**
 * End-to-end tests for llm_input/llm_output modifying hooks.
 *
 * Exercises the full plugin lifecycle: plugin registration via api.on() ->
 * registry loading -> hook runner creation -> modifying result consumption.
 * This validates that the contract works from a real plugin's perspective,
 * not just the hook merger internals.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  type TempPlugin,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { PluginRegistry } from "./registry.js";

const hookCtx: PluginHookAgentContext = {
  runId: "e2e-run",
  agentId: "main",
  sessionKey: "e2e-session-key",
  sessionId: "e2e-session",
  workspaceDir: "/tmp/e2e-test",
};

function loadPlugin(plugin: TempPlugin, config?: Record<string, unknown>): PluginRegistry {
  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugin.dir,
    config: {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
        entries: {
          [plugin.id]: {
            hooks: { allowConversationAccess: true },
            ...config,
          },
        },
      },
    },
  });
}

describe("llm_input/llm_output modifying hooks e2e", () => {
  beforeEach(() => {
    resetPluginLoaderTestStateForTest();
    useNoBundledPlugins();
  });

  afterEach(() => {
    resetPluginLoaderTestStateForTest();
  });

  it("plugin can block an LLM call via llm_input hook", async () => {
    const plugin = writePlugin({
      id: "blocker-plugin",
      filename: "blocker-plugin.cjs",
      body: `module.exports = { id: "blocker-plugin", register(api) {
  api.on("llm_input", (event) => {
    if (event.prompt.includes("BLOCKED")) {
      return { block: true, blockReason: "Content policy violation" };
    }
  });
} };`,
    });

    const registry = loadPlugin(plugin);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        prompt: "This should be BLOCKED",
        historyMessages: [],
        imagesCount: 0,
      },
      hookCtx,
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("Content policy violation");
  });

  it("plugin can rewrite prompt via llm_input hook", async () => {
    const plugin = writePlugin({
      id: "rewriter-plugin",
      filename: "rewriter-plugin.cjs",
      body: `module.exports = { id: "rewriter-plugin", register(api) {
  api.on("llm_input", (event) => {
    return { prompt: "[SANITIZED] " + event.prompt };
  });
} };`,
    });

    const registry = loadPlugin(plugin);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        prompt: "original prompt",
        historyMessages: [],
        imagesCount: 0,
      },
      hookCtx,
    );

    expect(result?.prompt).toBe("[SANITIZED] original prompt");
  });

  it("plugin can override system prompt via llm_input hook", async () => {
    const plugin = writePlugin({
      id: "sysprompt-plugin",
      filename: "sysprompt-plugin.cjs",
      body: `module.exports = { id: "sysprompt-plugin", register(api) {
  api.on("llm_input", () => {
    return { systemPrompt: "You are a compliance-approved assistant." };
  });
} };`,
    });

    const registry = loadPlugin(plugin);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        systemPrompt: "be helpful",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      hookCtx,
    );

    expect(result?.systemPrompt).toBe("You are a compliance-approved assistant.");
  });

  it("plugin can replace assistant output via llm_output hook", async () => {
    const plugin = writePlugin({
      id: "redactor-plugin",
      filename: "redactor-plugin.cjs",
      body: `module.exports = { id: "redactor-plugin", register(api) {
  api.on("llm_output", (event) => {
    return {
      assistantTexts: event.assistantTexts.map(
        (text) => text.replace(/secret/gi, "[REDACTED]")
      ),
    };
  });
} };`,
    });

    const registry = loadPlugin(plugin);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        assistantTexts: ["The secret password is hunter2"],
        usage: { input: 10, output: 20, total: 30 },
      },
      hookCtx,
    );

    expect(result?.assistantTexts).toEqual(["The [REDACTED] password is hunter2"]);
  });

  it("observe-only plugin (void return) does not affect results (backward compat)", async () => {
    const plugin = writePlugin({
      id: "observer-plugin",
      filename: "observer-plugin.cjs",
      body: `module.exports = { id: "observer-plugin", register(api) {
  api.on("llm_input", (event) => {
    // observe only, no return
  });
  api.on("llm_output", (event) => {
    // observe only, no return
  });
} };`,
    });

    const registry = loadPlugin(plugin);
    const runner = createHookRunner(registry);

    const inputResult = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      hookCtx,
    );
    expect(inputResult).toBeUndefined();

    const outputResult = await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        assistantTexts: ["unchanged"],
        usage: { input: 5, output: 10, total: 15 },
      },
      hookCtx,
    );
    expect(outputResult).toBeUndefined();
  });

  it("allowPromptInjection=false strips prompt/systemPrompt but keeps block", async () => {
    const plugin = writePlugin({
      id: "constrained-plugin",
      filename: "constrained-plugin.cjs",
      body: `module.exports = { id: "constrained-plugin", register(api) {
  api.on("llm_input", () => {
    return {
      block: true,
      blockReason: "blocked",
      prompt: "injected prompt",
      systemPrompt: "injected system prompt",
    };
  });
} };`,
    });

    const registry = loadPlugin(plugin, {
      hooks: {
        allowConversationAccess: true,
        allowPromptInjection: false,
      },
    });
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.5",
        prompt: "original",
        historyMessages: [],
        imagesCount: 0,
      },
      hookCtx,
    );

    // block/blockReason preserved, prompt/systemPrompt stripped
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("blocked");
    expect(result?.prompt).toBeUndefined();
    expect(result?.systemPrompt).toBeUndefined();
  });
});
