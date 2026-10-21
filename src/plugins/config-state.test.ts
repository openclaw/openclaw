import { afterEach, describe, expect, it, vi } from "vitest";
import * as bundledChannelCatalog from "../channels/bundled-channel-catalog-read.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  normalizePluginTargetConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";

type ActivationParams = Parameters<typeof resolveEffectivePluginActivationState>[0];
type Activation = ReturnType<typeof resolveEffectivePluginActivationState>;
type Provenance = Pick<Activation, "explicitlyEnabled" | "source" | "reason">;
const activation = (
  enabled: boolean,
  explicitlyEnabled: boolean,
  source: Activation["source"],
  reason?: string,
) => ({ enabled, activated: enabled, explicitlyEnabled, source, reason });
const entry = (id: string, enabled = true) => ({ entries: { [id]: { enabled } } });
const normalizeEntry = (value: Record<string, unknown>) =>
  normalizePluginsConfig({ entries: { "voice-call": value } }).entries["voice-call"];
function checkEnable(
  id: string,
  origin: "bundled" | "workspace",
  raw: Record<string, unknown>,
  expected: ReturnType<typeof resolveEnableState>,
  provenance?: Provenance,
  enabledByDefault?: boolean,
) {
  const config = normalizePluginsConfig(raw);
  expect(resolveEnableState(id, origin, config, enabledByDefault)).toEqual(expected);
  if (provenance) {
    expect(resolveEffectivePluginActivationState({ id, origin, config, enabledByDefault })).toEqual(
      {
        enabled: expected.enabled,
        activated: expected.enabled,
        ...provenance,
      },
    );
  }
}

describe("normalizePluginsConfig", () => {
  afterEach(clearRuntimeConfigSnapshot);
  it("serves published policy without rereading entries and refreshes every publication", () => {
    const entries = { "google-gemini-cli": { enabled: true } };
    const readEntries = vi.fn(() => entries);
    const config: OpenClawConfig = {
      plugins: {
        get entries() {
          return readEntries();
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    readEntries.mockClear();
    expect(normalizePluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
    expect(normalizePluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
    expect(readEntries).not.toHaveBeenCalled();
    entries["google-gemini-cli"].enabled = false;
    setRuntimeConfigSnapshot(config);
    expect(normalizePluginsConfig(config.plugins).entries.google?.enabled).toBe(false);
    const replacement = { plugins: { allow: ["replacement"] } };
    setRuntimeConfigSnapshot(replacement);
    expect(normalizePluginsConfig(replacement.plugins).allow).toEqual(["replacement"]);
    clearRuntimeConfigSnapshot();
    replacement.plugins.allow.push("unpublished-edit");
    expect(normalizePluginsConfig(replacement.plugins).allow).toEqual([
      "replacement",
      "unpublished-edit",
    ]);
  });
  it("keeps targeted authored plugin state identical across JSON persistence", () => {
    const normalized = normalizePluginTargetConfig(
      { plugins: { entries: { CODEX: { enabled: true, config: { appServer: {} } } } } },
      "codex",
    );
    const persistedJson = JSON.stringify(normalized);
    expect(JSON.parse(persistedJson)).toStrictEqual(normalized);
    expect(normalized.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: { appServer: {} },
    });
  });
  it.each([
    [{}, undefined],
    [{ slots: { contextEngine: "none" } }, null],
    [{ slots: { contextEngine: "  cortex  " } }, "cortex"],
    [{ slots: { contextEngine: "" } }, undefined],
  ] as const)("preserves contextEngine slot for %o (#64170)", (config, expected) => {
    expect(normalizePluginsConfig(config).slots.contextEngine).toBe(expected);
  });
  it.each([
    [
      "valid flags and timeouts",
      {
        allowPromptInjection: false,
        allowConversationAccess: true,
        timeoutMs: 250,
        timeouts: { before_prompt_build: 90_000, agent_end: 60_000 },
      },
      {
        allowPromptInjection: false,
        allowConversationAccess: true,
        timeoutMs: 250,
        timeouts: { before_prompt_build: 90_000, agent_end: 60_000 },
      },
    ],
    [
      "invalid flags and timeouts",
      {
        allowPromptInjection: "nope",
        allowConversationAccess: "nope",
        timeoutMs: 0,
        timeouts: { before_prompt_build: 900_000 },
      },
      undefined,
    ],
  ] as const)("normalizes hook policy: %s", (_name, hooks, expected) => {
    expect(normalizeEntry({ hooks })?.hooks).toEqual(expected);
  });
  it.each([
    [
      "trimmed model allowlist",
      {
        allowModelOverride: true,
        allowedModels: [" anthropic/claude-sonnet-4-6 ", "", "openai/gpt-5.5"],
      },
      {
        allowModelOverride: true,
        hasAllowedModelsConfig: true,
        allowedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
      },
    ],
    [
      "mixed allowlist entries",
      { allowModelOverride: true, allowedModels: [42, null, "anthropic"] },
      { allowModelOverride: true, hasAllowedModelsConfig: true, allowedModels: ["anthropic"] },
    ],
    [
      "explicit invalid allowlist",
      { allowModelOverride: "nope", allowedModels: [42, null] },
      { hasAllowedModelsConfig: true },
    ],
  ] as const)("normalizes subagent policy: %s", (_name, subagent, expected) => {
    expect(normalizeEntry({ subagent })?.subagent).toEqual(expected);
  });
  it("normalizes plugin llm override policy settings", () => {
    expect(
      normalizeEntry({
        llm: {
          allowModelOverride: true,
          allowedModels: [" openai/gpt-5.4 ", "", "anthropic/claude-sonnet-4-6"],
          allowedCompletionModels: [" openai/gpt-5.4 ", "", "google/gemini-3-flash"],
          allowAuthProfileOverride: true,
          allowAgentIdOverride: false,
        },
      })?.llm,
    ).toEqual({
      allowModelOverride: true,
      hasAllowedModelsConfig: true,
      allowedModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
      hasAllowedCompletionModelsConfig: true,
      allowedCompletionModels: ["openai/gpt-5.4", "google/gemini-3-flash"],
      allowAuthProfileOverride: true,
      allowAgentIdOverride: false,
    });
  });
});

it("does not bypass allowlists for non-bundled plugins that reuse a channel id", () => {
  expect(
    resolveEffectiveEnableState({
      id: "telegram",
      origin: "config",
      config: normalizePluginsConfig({ enabled: true, allow: ["browser"] }),
      rootConfig: { channels: { telegram: { enabled: true } } },
    }),
  ).toEqual({ enabled: false, reason: "not in allowlist" });
});

describe("resolveEffectivePluginActivationState", () => {
  it.each([
    ["multi-channel", false, true, true],
    ["multi-channel", false, undefined, true],
    // Manifest ownership overrides the same-named built-in channel.
    ["telegram", false, false, false],
    ["telegram", undefined, undefined, true],
  ] as const)(
    "keeps multi-channel activation independent of order: %s %s %s",
    (id, alpha, beta, expected) => {
      const rootConfig = {
        plugins: entry(id),
        channels: {
          alpha: { enabled: alpha },
          beta: { enabled: beta },
          telegram: { enabled: !expected },
        },
      };
      for (const channelIds of [
        ["alpha", "beta"],
        ["beta", "alpha"],
      ]) {
        const params = {
          id,
          origin: "config" as const,
          config: normalizePluginsConfig(rootConfig.plugins),
          rootConfig,
          channelIds,
        };
        expect(resolveEffectivePluginActivationState(params)).toMatchObject({
          enabled: expected,
          activated: expected,
        });
      }
    },
  );

  type Case = [
    name: string,
    params: Pick<
      ActivationParams,
      "id" | "origin" | "enabledByDefault" | "autoEnabledReason" | "channelIds"
    >,
    rawConfig: OpenClawConfig | undefined,
    expected: Activation,
    effectiveConfig?: OpenClawConfig,
  ];
  it.each<Case>([
    [
      "auto activation",
      { id: "telegram", origin: "bundled", autoEnabledReason: "telegram configured" },
      { channels: { telegram: { botToken: "x" } } },
      activation(true, false, "auto", "telegram configured"),
      { channels: { telegram: { botToken: "x", enabled: true } } },
    ],
    [
      "global disable preserves explicit selection",
      { id: "browser", origin: "bundled" },
      { plugins: { enabled: false, ...entry("browser") } },
      activation(false, true, "disabled", "plugins disabled"),
    ],
    [
      "bundled default",
      { id: "openai", origin: "bundled", enabledByDefault: true },
      {},
      activation(true, false, "default", "bundled default enablement"),
    ],
    [
      "bundled default with effective entry",
      { id: "acpx", origin: "bundled", enabledByDefault: true },
      { acp: { enabled: true } },
      activation(true, false, "default", "bundled default enablement"),
      { acp: { enabled: true }, plugins: entry("acpx") },
    ],
    [
      "bundled default with auto-enable reason",
      {
        id: "acpx",
        origin: "bundled",
        enabledByDefault: true,
        autoEnabledReason: "ACP runtime configured",
      },
      {},
      activation(true, false, "default", "bundled default enablement"),
    ],
    [
      "allowlist overrides plugin enable",
      { id: "telegram", origin: "bundled" },
      { plugins: { allow: ["browser"], ...entry("telegram") } },
      activation(false, true, "disabled", "not in allowlist"),
    ],
    [
      "effective-only plugin enable",
      { id: "openai", origin: "bundled" },
      { plugins: {} },
      activation(true, false, "auto", "enabled by effective config"),
      { plugins: entry("openai") },
    ],
    [
      "effective-only channel enable",
      { id: "telegram", origin: "bundled" },
      {},
      activation(true, false, "auto", "channel configured"),
      { channels: { telegram: { enabled: true } } },
    ],
    [
      "manifest-owned channel disable",
      { id: "openclaw-demo", origin: "bundled", channelIds: ["demo"] },
      { channels: { demo: { enabled: false } }, plugins: entry("openclaw-demo") },
      activation(false, true, "disabled", "channel disabled in config"),
    ],
    [
      "external default has no invented provenance",
      { id: "global-helper", origin: "global" },
      undefined,
      activation(true, false, "default"),
    ],
  ])("%s", (_name, params, rawConfig, expected, effectiveConfig = rawConfig) => {
    const catalog = vi.spyOn(bundledChannelCatalog, "listBundledChannelCatalogEntries");
    try {
      expect(
        resolveEffectivePluginActivationState({
          ...params,
          config: normalizePluginsConfig(effectiveConfig ? effectiveConfig.plugins : {}),
          ...(effectiveConfig ? { rootConfig: effectiveConfig } : {}),
          ...(rawConfig
            ? { activationSource: createPluginActivationSource({ config: rawConfig }) }
            : {}),
        }),
      ).toEqual(expected);
      if (!rawConfig?.channels && !effectiveConfig?.channels) {
        expect(catalog).not.toHaveBeenCalled();
      }
    } finally {
      catalog.mockRestore();
    }
  });
});

describe("resolveEnableState", () => {
  it.each([undefined, true])("resolves bundled default=%s", (enabledByDefault) => {
    const reason = "bundled (disabled by default)";
    checkEnable(
      "openai",
      "bundled",
      {},
      enabledByDefault ? { enabled: true } : { enabled: false, reason },
      enabledByDefault ? undefined : { explicitlyEnabled: false, source: "disabled", reason },
      enabledByDefault,
    );
  });
  it.each([true, false])("resolves selected memory slot with enabled=%s", (enabled) => {
    checkEnable(
      "memory-core",
      "bundled",
      {
        allow: ["telegram"],
        slots: { memory: "memory-core" },
        ...(enabled ? {} : entry("memory-core", false)),
      },
      enabled ? { enabled: true } : { enabled: false, reason: "disabled in config" },
      {
        explicitlyEnabled: true,
        source: enabled ? "explicit" : "disabled",
        reason: enabled ? "selected memory slot" : "disabled in config",
      },
    );
  });
  it.each([
    [{ allow: ["workspace-helper"] }, "selected in allowlist"],
    [entry("workspace-helper"), "enabled in config"],
  ] as const)("resolves workspace-helper enable state for %o", (config, reason) => {
    checkEnable(
      "workspace-helper",
      "workspace",
      config,
      { enabled: true },
      { explicitlyEnabled: true, source: "explicit", reason },
    );
  });
  it("does not let the default memory slot auto-enable an untrusted workspace plugin", () => {
    const reason = "workspace plugin (disabled by default)";
    checkEnable(
      "memory-core",
      "workspace",
      { slots: { memory: "memory-core" } },
      { enabled: false, reason },
      { explicitlyEnabled: true, source: "disabled", reason },
    );
  });
  it("keeps an explicitly selected workspace context engine enabled when omitted from plugins.allow", () => {
    checkEnable(
      "lossless-claw",
      "workspace",
      { allow: ["telegram"], slots: { contextEngine: "lossless-claw" } },
      { enabled: true },
    );
  });
});

describe("resolveMemorySlotDecision", () => {
  it.each([
    ["memory", "new-memory", { enabled: false }],
    [["memory", "context-engine"], "new-memory", { enabled: true, selected: undefined }],
    [["memory", "context-engine"], "memory-plugin", { enabled: true, selected: true }],
    [["memory", "context-engine"], null, { enabled: true }],
    ["memory", null, { enabled: false }],
  ] as const)("resolves kind=%j slot=%s", (kind, slot, expected) => {
    const result = resolveMemorySlotDecision({
      id: "memory-plugin",
      kind: typeof kind === "string" ? kind : [...kind],
      slot,
      selectedId: null,
    });
    expect({ enabled: result.enabled, selected: result.selected }).toMatchObject(expected);
  });
});
