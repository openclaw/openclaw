import { afterEach, describe, expect, test } from "vitest";
import { resolveThinkingDefault } from "../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildGatewaySessionRow, getSessionDefaults } from "./session-utils.js";

function makeConfig(thinkingDefault?: string, perModelThinking?: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "ollama/gemma3:4b" },
        ...(thinkingDefault ? { thinkingDefault } : {}),
        ...(perModelThinking
          ? { models: { "ollama/gemma3:4b": { params: { thinking: perModelThinking } } } }
          : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

// Regression coverage for https://github.com/openclaw/openclaw/issues/72407 —
// the gateway must hand the UI the same thinking default the runtime resolves,
// otherwise users see "Default (off)" while the model is actually thinking
// adaptively.
describe("getSessionDefaults thinkingDefault — issue #72407", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  test("honors agents.defaults.thinkingDefault for non-reasoning models", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = makeConfig("adaptive");

    expect(resolveThinkingDefault({ cfg, provider: "ollama", model: "gemma3:4b" })).toBe(
      "adaptive",
    );
    expect(getSessionDefaults(cfg).thinkingDefault).toBe("adaptive");
  });

  test("honors per-model params.thinking when global default is unset", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = makeConfig(undefined, "adaptive");

    expect(resolveThinkingDefault({ cfg, provider: "ollama", model: "gemma3:4b" })).toBe(
      "adaptive",
    );
    expect(getSessionDefaults(cfg).thinkingDefault).toBe("adaptive");
  });

  test("per-model params.thinking wins over global agents.defaults.thinkingDefault", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = makeConfig("low", "adaptive");

    expect(resolveThinkingDefault({ cfg, provider: "ollama", model: "gemma3:4b" })).toBe(
      "adaptive",
    );
    expect(getSessionDefaults(cfg).thinkingDefault).toBe("adaptive");
  });

  test("UI label matches runtime resolution when no config override is set", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = makeConfig();

    const backend = resolveThinkingDefault({ cfg, provider: "ollama", model: "gemma3:4b" });
    expect(getSessionDefaults(cfg).thinkingDefault).toBe(backend);
  });
});

// Symmetric coverage for the second patched call site: per-row session payload.
// `buildGatewaySessionRow` should produce the same `thinkingDefault` for a row
// as `resolveThinkingDefault` would for the row's resolved (provider, model).
describe("buildGatewaySessionRow thinkingDefault — issue #72407", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  function buildRow(cfg: OpenClawConfig) {
    return buildGatewaySessionRow({
      cfg,
      storePath: "/tmp/store.json",
      store: {},
      key: "main",
      now: 0,
    });
  }

  test("row honors agents.defaults.thinkingDefault for non-reasoning models", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(buildRow(makeConfig("adaptive")).thinkingDefault).toBe("adaptive");
  });

  test("row honors per-model params.thinking when global default is unset", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(buildRow(makeConfig(undefined, "adaptive")).thinkingDefault).toBe("adaptive");
  });

  test("row uses per-model params.thinking over global default", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(buildRow(makeConfig("low", "adaptive")).thinkingDefault).toBe("adaptive");
  });

  test("row label matches runtime resolution when no config override is set", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = makeConfig();
    const backend = resolveThinkingDefault({ cfg, provider: "ollama", model: "gemma3:4b" });
    expect(buildRow(cfg).thinkingDefault).toBe(backend);
  });
});
