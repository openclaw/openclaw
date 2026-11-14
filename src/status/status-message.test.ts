import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { model as catalogModel } from "../agents/model-catalog-fixtures.test-support.js";
import type { SessionEntry } from "../config/sessions.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return { ...actual, resolveRuntimeServiceCommit: () => "aaaaaaa" };
});
import {
  buildStatusMessage,
  buildStatusMessageParts,
  statusModelRefs,
} from "./status-message.test-support.js";

function statusTestModel(id: string, name: string, contextWindow: number): ModelDefinitionConfig {
  return catalogModel(id, name, { contextWindow, maxTokens: 8_192 });
}

const displayParams: Partial<Parameters<typeof buildStatusMessage>[0]> = {
  sessionKey: "agent:main:main",
  sessionScope: "per-sender",
  queue: { mode: "steer", depth: 0 },
  modelAuth: "api-key",
};
type StatusArgs = Parameters<typeof buildStatusMessage>[0];
const session = (totalTokens: number, fields: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "status-session",
  updatedAt: 0,
  totalTokens,
  totalTokensFresh: true,
  totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
  ...fields,
});
const haiku = {
  ...displayParams,
  modelRefs: statusModelRefs({ provider: "anthropic", model: "claude-haiku-4-5" }),
  config: { agents: { defaults: { userTimezone: "UTC" } } },
  agent: { model: "anthropic/claude-haiku-4-5" },
};
const providerConfig = (
  provider: string,
  baseUrl: string,
  models: ModelDefinitionConfig[],
): OpenClawConfig => ({ models: { providers: { [provider]: { baseUrl, models } } } });
function statusTable(parts: ReturnType<typeof buildStatusMessageParts>) {
  const table = parts.presentation.blocks.find((block) => block.type === "table");
  if (!table) {
    throw new Error("expected table block");
  }
  return table;
}
const statusRows = (parts: ReturnType<typeof buildStatusMessageParts>) =>
  new Map(statusTable(parts).rows.map((row) => [row[0], row[1]]));

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("buildStatusMessageParts presentation", () => {
  it.each(["openai", "anthropic"])(
    "shows configured text verbosity only for OpenAI (%s)",
    (provider) => {
      const parts = buildStatusMessageParts({
        modelRefs: statusModelRefs({ provider, model: "verbosity-model" }),
        agent: { model: `${provider}/verbosity-model` },
        config: {
          agents: {
            defaults: {
              models: { [`${provider}/verbosity-model`]: { params: { textVerbosity: "low" } } },
            },
          },
        },
      });
      expect(parts.text.includes("text low")).toBe(provider === "openai");
      const modes = statusRows(parts).get("🎛️ Modes");
      expect(String(modes).includes("text low")).toBe(provider === "openai");
    },
  );

  it("mirrors the text body as a titled status table with context lines", () => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(1_751_529_600_000);
    const parts = buildStatusMessageParts({
      ...haiku,
      uptimeValue: "gateway 1h · system 2d",
      channelFeatureLine: "Telegram rich messages: on · Bot API 10.3 sendRichMessage enabled",
    });

    expect(parts.text).toContain("⏱️ Uptime: gateway 1h · system 2d");
    expect(parts.text).toContain("Current time:");
    expect(parts.text).toContain("(UTC)");
    expect(parts.text).toContain("Reference UTC: 2025-07-03 08:00 UTC");
    expect(parts.text).toContain("Telegram rich messages: on");
    expect(parts.presentation.title).toMatch(/^🦞 OpenClaw /);
    expect(parts.presentation.title).toContain("(aaaaaaa)");
    const table = statusTable(parts);
    expect(table.headers).toEqual(["Item", "Value"]);
    expect(table.rowHeaderColumnIndex).toBe(0);
    expect(
      table.rows.every((row) => row.length === 2 && row.every((cell) => String(cell).trim())),
    ).toBe(true);
    const contextTexts = parts.presentation.blocks.flatMap((block) =>
      block.type === "context" ? [block.text] : [],
    );
    const clockLine = contextTexts.find((entry) => entry.includes("⏱️ gateway 1h · system 2d"));
    expect(clockLine).toContain("(UTC)");
    expect(contextTexts.join("\n")).not.toContain("Reference UTC");
    expect(contextTexts.join("\n")).not.toContain("Telegram rich messages");
    const rows = new Map(table.rows.map((row) => [row[0], row[1]]));
    expect(rows.has("🧹 Compactions")).toBe(false);
    expect(rows.get("🪢 Queue")).toBe("steer");
    expect(String(rows.get("📚 Context"))).not.toContain("▰");
    expect(parts.presentation.blocks.some((block) => block.type === "text")).toBe(false);
  });

  it("shows the sanitized endpoint in text and tables", () => {
    const parts = buildStatusMessageParts({
      modelRefs: statusModelRefs({ provider: "openai", model: "selected-model" }),
      agent: { model: "openai/selected-model" },
      selectedEndpoint: "https://user:secret@api.openai.com/v1?token=private#private",
    });
    const rows = statusRows(parts);
    expect(parts.text).toContain("Endpoint: https://api.openai.com/v1");
    expect(rows.get("🌐 Endpoint")).toBe("https://api.openai.com/v1");
    expect(JSON.stringify(parts)).not.toMatch(/secret|private|user:/);
  });

  it("does not infer endpoints from a model or credential label without route facts", () => {
    const parts = buildStatusMessageParts({
      modelRefs: statusModelRefs({ provider: "openai", model: "selected-model" }),
      agent: { model: "openai/selected-model" },
      modelAuth: "oauth (codex)",
    });
    expect(parts.text).toContain("Endpoint: unknown");
    expect(JSON.stringify(parts)).not.toContain("https://");
  });

  it.each([undefined, true] as const)(
    "shows context pressure and persisted compaction degradation (%s)",
    (compactionQualityDegraded) => {
      using _ = vi.spyOn(Date, "now").mockReturnValue(1_751_529_600_000);
      const parts = buildStatusMessageParts({
        ...haiku,
        runtimeContextTokens: 100_000,
        sessionEntry: session(87_000, {
          compactionCount: 2,
          compactionQualityDegraded,
          updatedAt: 1_751_529_500_000,
        }),
        queue: { mode: "steer", depth: 3 },
      });

      const rows = statusRows(parts);
      expect(String(rows.get("📚 Context"))).toMatch(/^▰{9}▱ /);
      const compactions = compactionQualityDegraded
        ? "2 · degraded history (details may be lost)"
        : "2";
      expect(rows.get("🧹 Compactions")).toBe(compactions);
      expect(parts.text).toContain(`🧹 Compactions: ${compactions}`);
      expect(rows.get("🪢 Queue")).toBe("steer (depth 3)");
      const warning = parts.presentation.blocks.find(
        (block) => block.type === "text" && block.text.startsWith("⚠️ Context"),
      );
      expect(warning?.type === "text" ? warning.text : "").toBe("⚠️ Context 87% full");
    },
  );
});

describe("buildStatusMessage cost snapshot", () => {
  it.each([
    ["recorded per-call total", 0.25, true, "Cost: $0.25", true],
    ["recorded zero", 0, true, "Cost: $0.0000", true],
    ["unknown tiered total", undefined, true, undefined, true],
    ["legacy flat estimate", undefined, false, "Cost: $0.30", true],
    ["cost-only zero total", 0, true, "Cost: $0.0000", false],
  ] as const)(
    "uses %s without repricing combined calls",
    (_name, recorded, tiered, expected, tokens) => {
      const text = buildStatusMessage({
        modelRefs: statusModelRefs({ provider: "fixture", model: "priced" }),
        agent: { model: "fixture/priced" },
        config: providerConfig("fixture", "https://fixture.invalid", [
          {
            ...statusTestModel("priced", "Priced", 1_000_000),
            cost: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              ...(tiered
                ? {
                    tieredPricing: [
                      { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, range: [200_000] },
                    ],
                  }
                : {}),
            },
          },
        ]),
        sessionEntry: {
          sessionId: "status-cost",
          updatedAt: 0,
          modelProvider: "fixture",
          model: "priced",
          ...(tokens ? { inputTokens: 300_000, outputTokens: 200 } : {}),
          estimatedCostUsd: recorded,
        },
      });

      if (expected) {
        expect(text).toContain(expected);
      } else {
        expect(text).not.toContain("Cost:");
      }
      if (!tokens) {
        expect(text).not.toContain("Tokens:");
        expect(text).not.toContain("Cache:");
      }
    },
  );
});

describe("buildStatusMessage cache usage", () => {
  it.each([
    { source: "session", cacheRead: 0, cacheWrite: 0 },
    { source: "session", cacheRead: undefined, cacheWrite: undefined },
    { source: "transcript", cacheRead: 0, cacheWrite: undefined },
    { source: "transcript", cacheRead: undefined, cacheWrite: undefined },
    { source: "session with unreported transcript", cacheRead: 0, cacheWrite: 0 },
  ])(
    "distinguishes $source cache usage ($cacheRead, $cacheWrite)",
    ({ source, cacheRead, cacheWrite }) => {
      const usage = { inputTokens: 10_000, outputTokens: 50, cacheRead, cacheWrite };
      const transcriptUsage =
        source === "transcript"
          ? usage
          : source === "session with unreported transcript"
            ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
            : null;
      const parts = buildStatusMessageParts({
        modelRefs: statusModelRefs({ provider: "anthropic", model: "claude-haiku-4-5" }),
        agent: { model: "anthropic/claude-haiku-4-5" },
        sessionEntry: {
          sessionId: "status-cache",
          updatedAt: 0,
          ...(source !== "transcript" ? usage : {}),
        },
        transcriptUsage,
      });
      const rows = statusRows(parts);
      if (cacheRead === 0) {
        expect(parts.text).toContain("Cache: 0% hit · 0 cached, 0 new");
        expect(rows.get("🗄️ Cache")).toBe("0% hit · 0 cached, 0 new");
      } else {
        expect(parts.text).not.toContain("Cache:");
        expect(rows.has("🗄️ Cache")).toBe(false);
      }
    },
  );
});

describe("buildStatusMessage context window", () => {
  function windowStatus(entry: Partial<SessionEntry>, overrides: Partial<StatusArgs> = {}) {
    return buildStatusMessage({
      ...displayParams,
      modelRefs: statusModelRefs({ provider: "openai", model: "gpt-5.6-luna" }),
      agent: { model: "openai/gpt-5.6-luna" },
      runtimeContextTokens: 1_000_000,
      resolvedHarness: "codex",
      modelAuth: "oauth",
      ...overrides,
      sessionEntry: session(11, entry),
    });
  }
  const lunarConfig = (contextTokens: number): OpenClawConfig => ({
    agents: { defaults: { model: "openai/gpt-5.6-luna" } },
    ...providerConfig("openai", "https://api.openai.com/v1", [
      {
        ...statusTestModel("gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000),
        contextTokens,
      },
    ]),
  });
  const runtimeEntry: Partial<SessionEntry> = {
    modelProvider: "openai",
    model: "gpt-5.6-luna",
    agentHarnessId: "codex",
    contextTokens: 272_000,
    contextTokensSource: "runtime",
  };
  const cloudFallbackConfig = providerConfig("ollama-cloud", "https://ollama.com", [
    statusTestModel("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
    statusTestModel("qwen3.6-blue", "Qwen 3.6 Blue", 128_000),
  ]);
  function cloudStatus(
    model: string,
    entry: Partial<SessionEntry>,
    overrides: Partial<StatusArgs> = {},
  ) {
    return buildStatusMessage({
      ...displayParams,
      modelRefs: statusModelRefs(
        { provider: "ollama-cloud", model },
        { provider: "ollama-cloud", model: "deepseek-v4-pro" },
      ),
      config: cloudFallbackConfig,
      agent: { model: "ollama-cloud/deepseek-v4-pro" },
      configuredDefaultModelLabel: "ollama-cloud/deepseek-v4-pro",
      ...overrides,
      sessionEntry: {
        sessionId: "cloud-model",
        updatedAt: 0,
        providerOverride: "ollama-cloud",
        modelOverride: model,
        ...entry,
      },
    });
  }

  it("replaces matching runtime telemetry with a newly authored effective cap", () => {
    const text = windowStatus(runtimeEntry, { config: lunarConfig(1_000_000) });
    expect(text).toContain("Context: 11/1.0m");
    expect(text).not.toContain("Context: 11/272k");
  });

  it("caps matching unlocked runtime telemetry to the lower current window", () => {
    const text = windowStatus(
      { ...runtimeEntry, contextTokens: 1_000_000 },
      { runtimeContextTokens: 272_000 },
    );
    expect(text).toContain("Context: 11/272k");
    expect(text).not.toContain("Context: 11/1.0m");
  });

  it("ignores stale runtime context after a manual session model switch", () => {
    const text = cloudStatus(
      "glm-5.1",
      session(128_393, {
        modelOverrideSource: "user",
        modelProvider: "ollama-cloud",
        model: "deepseek-v4-pro",
      }),
      {
        config: providerConfig("ollama-cloud", "https://ollama.com", [
          statusTestModel("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
          statusTestModel("glm-5.1", "GLM 5.1", 200_000),
        ]),
        runtimeContextTokens: 1_000_000,
        sessionKey: "agent:main:telegram:direct:584667058",
      },
    );

    expect(text).toContain("Model: ollama-cloud/glm-5.1");
    expect(text).toContain("pinned session; config primary ollama-cloud/deepseek-v4-pro");
    expect(text).toContain("Context: 128k/200k");
    expect(text).not.toContain("Context: 128k/1.0m");
    expect(text).not.toContain("live switch pending");
  });

  it("flags a pending live model switch on the model line", () => {
    // A /model switch issued during an active run stays pending until a turn
    // applies it; /status must not imply the new selection is already running.
    const text = buildStatusMessage({
      ...displayParams,
      modelRefs: statusModelRefs({ provider: "openai", model: "gpt-5.5" }),
      config: {},
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: {
        sessionId: "pending-live-switch",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        liveModelSwitchPending: true,
      },
    });

    expect(text).toContain("Model: openai/gpt-5.5");
    expect(text).toContain("⏳ live switch pending");
  });

  it("keeps trusted runtime context for config-backed runtime aliases", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for a targeted runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    const text = buildStatusMessage({
      ...displayParams,
      modelRefs: statusModelRefs(
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "claude-cli", model: "claude-haiku-4-5" },
      ),
      config: {
        agents: { defaults: {} },
        ...providerConfig("anthropic", "https://api.anthropic.com", [
          statusTestModel("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
        ]),
      },
      agent: {
        model: "anthropic/claude-haiku-4-5",
      },
      runtimeContextTokens: 1_000_000,
      sessionEntry: session(36_000, {
        modelProvider: "claude-cli",
        model: "claude-haiku-4-5",
      }),
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
      activeModelAuth: "oauth",
    });

    expect(text).toContain("Model: anthropic/claude-haiku-4-5");
    expect(text).toContain("Context: 36k/1.0m");
    expect(text).not.toContain("Context: 36k/200k");
  });

  it("shows auto-fallback override label when model differs from configured default", () => {
    const text = cloudStatus(
      "qwen3.6-blue",
      session(50_000, {
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "ollama-cloud",
        modelOverrideFallbackOriginModel: "deepseek-v4-pro",
        modelProvider: "ollama-cloud",
        model: "deepseek-v4-pro",
        agentHarnessId: "openclaw",
        contextTokens: 128_000,
        contextTokensSource: "runtime",
      }),
      {
        runtimeContextTokens: 128_000,
        sessionKey: "agent:main:telegram:direct:auto-fallback",
        resolvedHarness: "openclaw",
      },
    );

    expect(text).toContain("Model: ollama-cloud/qwen3.6-blue");
    expect(text).toContain("auto fallback; config primary ollama-cloud/deepseek-v4-pro");
    expect(text).toContain("check provider");
    expect(text).not.toContain("pinned session");
    expect(text).toContain("Context: 50k/128k");
  });

  it("does not label a configured subagent model as auto fallback", () => {
    const text = cloudStatus(
      "qwen3.6-blue",
      {
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "ollama-cloud",
        modelOverrideFallbackOriginModel: "qwen3.6-blue",
      },
      {
        modelRefs: statusModelRefs({ provider: "ollama-cloud", model: "qwen3.6-blue" }),
        sessionKey: "agent:worker:subagent:configured",
      },
    );

    expect(text).toContain("Model: ollama-cloud/qwen3.6-blue");
    expect(text).not.toContain("auto fallback");
    expect(text).not.toContain("check provider");
    expect(text).not.toContain("pinned session");
  });
});
