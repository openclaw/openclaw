// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
// Split out of loader.hooks-and-runtime.test-utils.ts: that module is grandfathered
// at its current size by the line-cap ratchet and must not grow, so the
// conversation-access and prompt-injection hook-policy cases live here together.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import {
  globalAfterAll1,
  globalAfterEach0,
  loadRegistryFromSinglePlugin,
  writeBundledPlugin,
} from "./loader.test-harness.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

describe("loadOpenClawPlugins conversation-access and prompt-injection hook policy", () => {
  it("blocks before_prompt_build but preserves model resolution overrides when prompt injection is disabled", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy",
      filename: "hook-policy.cjs",
      registration: `api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
      api.on("before_model_resolve", () => ({
        modelOverride: "demo-model",
        providerOverride: "demo-provider",
      }));`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy"],
        entries: {
          "hook-policy": {
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess: true,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-policy")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeModelResolve({ prompt: "hello" }, {});
    expect(result).toEqual({
      modelOverride: "demo-model",
      providerOverride: "demo-provider",
    });
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false; the handler is not registered and will never run",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(1);
    // Explicit operator denial: stays a warning, never escalated to error.
    expect(blockedDiagnostics[0]?.level).toBe("warn");
    expect(blockedDiagnostics[0]?.code).toBe("hook-registration-blocked");
    expect(registry.blockedHooks).toStrictEqual([
      {
        pluginId: "hook-policy",
        hookName: "before_prompt_build",
        reason: "prompt-injection-denied",
        severity: "warn",
        configPath: "plugins.entries.hook-policy.hooks.allowPromptInjection",
        message:
          'typed hook "before_prompt_build" blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false; the handler is not registered and will never run',
        source: expect.any(String),
      },
    ]);
  });
  it("attributes the two prompt-injection conversation hooks to allowPromptInjection when conversation access is unset", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "injection-precedence",
      filename: "injection-precedence.cjs",
      body: `module.exports = { id: "injection-precedence", register(api) {
    api.on("agent_turn_prepare", () => undefined);
    api.on("before_prompt_build", () => undefined);
  } };`,
    });

    // `agent_turn_prepare` and `before_prompt_build` are the only two hooks that
    // are BOTH prompt-injection hooks and conversation hooks, and the
    // prompt-injection branch is evaluated first. So a non-bundled plugin with
    // `allowPromptInjection: false` and no `allowConversationAccess` setting at
    // all gets a "warn" attributed to allowPromptInjection -- not the "error"
    // that an unset allowConversationAccess produces on its own. This is the
    // precedence exception the config reference and plugin guide document.
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["injection-precedence"],
        entries: {
          "injection-precedence": {
            hooks: { allowPromptInjection: false },
          },
        },
      },
    });

    expect(registry.typedHooks).toHaveLength(0);
    expect(
      registry.blockedHooks
        .map((entry) => ({
          hookName: entry.hookName,
          reason: entry.reason,
          severity: entry.severity,
          configPath: entry.configPath,
        }))
        .toSorted((a, b) => a.hookName.localeCompare(b.hookName)),
    ).toStrictEqual([
      {
        hookName: "agent_turn_prepare",
        reason: "prompt-injection-denied",
        severity: "warn",
        configPath: "plugins.entries.injection-precedence.hooks.allowPromptInjection",
      },
      {
        hookName: "before_prompt_build",
        reason: "prompt-injection-denied",
        severity: "warn",
        configPath: "plugins.entries.injection-precedence.hooks.allowPromptInjection",
      },
    ]);
    // The implicit-deny escalation must not leak through the earlier branch.
    expect(registry.blockedHooks.some((entry) => entry.severity === "error")).toBe(false);
    expect(
      registry.blockedHooks.some((entry) => entry.reason === "conversation-access-missing"),
    ).toBe(false);
  });
  it("blocks conversation typed hooks for non-bundled plugins unless explicitly allowed", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "conversation-hooks",
      filename: "conversation-hooks.cjs",
      registration: `api.on("before_model_resolve", () => undefined);
      api.on("agent_turn_prepare", () => undefined);
      api.on("before_prompt_build", () => undefined);
      api.on("before_agent_reply", () => undefined);
      api.on("llm_input", () => undefined);
      api.on("llm_output", () => undefined);
      api.on("before_agent_finalize", () => undefined);
      api.on("agent_end", () => undefined);
      api.on("before_agent_run", () => undefined);`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["conversation-hooks"],
      },
    });

    expect(registry.typedHooks).toStrictEqual([]);
    const blockedDiagnostics = registry.diagnostics.filter(
      (diag) => diag.code === "hook-registration-blocked" && diag.pluginId === "conversation-hooks",
    );
    expect(blockedDiagnostics).toHaveLength(9);
    // Implicit deny: the operator never expressed an opinion, so the plugin is
    // silently degraded. That is an error, and the message has to be actionable.
    expect(blockedDiagnostics.every((diag) => diag.level === "error")).toBe(true);
    const promptBuildDiagnostic = blockedDiagnostics.find((diag) =>
      diag.message.includes('"before_prompt_build"'),
    );
    expect(promptBuildDiagnostic?.message).toContain("was NOT registered");
    // Exact config path, remedy, and how to verify.
    expect(promptBuildDiagnostic?.message).toContain(
      "plugins.entries.conversation-hooks.hooks.allowConversationAccess",
    );
    expect(promptBuildDiagnostic?.message).toContain("restart the Gateway");
    expect(promptBuildDiagnostic?.message).toContain(
      "openclaw plugins inspect conversation-hooks --runtime",
    );
    expect(promptBuildDiagnostic?.message).toContain("/status plugins");
    // And the refusal is queryable off the registry, not just in the log scroll.
    expect(registry.blockedHooks.map((entry) => entry.hookName).toSorted()).toStrictEqual(
      [
        "agent_end",
        "agent_turn_prepare",
        "before_agent_finalize",
        "before_agent_reply",
        "before_agent_run",
        "before_model_resolve",
        "before_prompt_build",
        "llm_input",
        "llm_output",
      ].toSorted(),
    );
    expect(
      registry.blockedHooks.every(
        (entry) =>
          entry.pluginId === "conversation-hooks" &&
          entry.reason === "conversation-access-missing" &&
          entry.severity === "error" &&
          entry.configPath === "plugins.entries.conversation-hooks.hooks.allowConversationAccess",
      ),
    ).toBe(true);
  });
  it("keeps an explicit bundled conversation-access denial at warn", () => {
    writeBundledPlugin({
      id: "bundled-conversation-denied",
      filename: "bundled-conversation-denied.cjs",
      body: `module.exports = { id: "bundled-conversation-denied", register(api) {
    api.on("before_prompt_build", () => undefined);
  } };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled-conversation-denied"],
          entries: {
            "bundled-conversation-denied": {
              enabled: true,
              hooks: {
                allowConversationAccess: false,
              },
            },
          },
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "bundled-conversation-denied")?.origin,
    ).toBe("bundled");
    expect(registry.typedHooks).toStrictEqual([]);
    expect(registry.blockedHooks).toStrictEqual([
      {
        pluginId: "bundled-conversation-denied",
        hookName: "before_prompt_build",
        reason: "conversation-access-denied",
        severity: "warn",
        configPath: "plugins.entries.bundled-conversation-denied.hooks.allowConversationAccess",
        message:
          'typed hook "before_prompt_build" blocked by plugins.entries.bundled-conversation-denied.hooks.allowConversationAccess=false; the handler is not registered and will never run',
        source: expect.any(String),
      },
    ]);
    const blockedDiagnostics = registry.diagnostics.filter(
      (diag) => diag.code === "hook-registration-blocked",
    );
    expect(blockedDiagnostics).toHaveLength(1);
    // Deliberate configuration is not an error.
    expect(blockedDiagnostics[0]?.level).toBe("warn");
  });

  it("keeps an explicit NON-bundled conversation-access denial at warn, not error", () => {
    // Regression: `origin !== "bundled" && access !== true` also matches an
    // explicit `false`, so a deliberate denial on a non-bundled plugin used to
    // be reported as the implicit-deny error — raising the severity of a choice
    // the operator made and telling them to set a key they had already set.
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "nonbundled-conversation-denied",
      filename: "nonbundled-conversation-denied.cjs",
      body: `module.exports = { id: "nonbundled-conversation-denied", register(api) {
    api.on("before_prompt_build", () => undefined);
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["nonbundled-conversation-denied"],
        entries: {
          "nonbundled-conversation-denied": {
            hooks: {
              allowConversationAccess: false,
            },
          },
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "nonbundled-conversation-denied")?.origin,
    ).not.toBe("bundled");
    expect(registry.typedHooks).toStrictEqual([]);
    expect(registry.blockedHooks).toHaveLength(1);
    expect(registry.blockedHooks[0]?.reason).toBe("conversation-access-denied");
    expect(registry.blockedHooks[0]?.severity).toBe("warn");
    const blockedDiagnostics = registry.diagnostics.filter(
      (diag) => diag.code === "hook-registration-blocked",
    );
    expect(blockedDiagnostics).toHaveLength(1);
    expect(blockedDiagnostics[0]?.level).toBe("warn");
    // The implicit-deny copy tells the operator the key is unset; it must not
    // appear for a key they explicitly set.
    expect(blockedDiagnostics[0]?.message).not.toContain("is unset");
  });
});
