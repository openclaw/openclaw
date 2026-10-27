import { afterEach, describe, expect, it, vi } from "vitest";
import * as bundledChannelCatalog from "../channels/bundled-channel-catalog-read.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  normalizePluginTargetConfig,
  resolveEligibleContextEngineOwnerIds,
  resolveEffectiveEnableState,
  resolveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
  resolveSelectedContextEnginePluginId,
  resolveSelectedContextEnginePluginIdFromConfig,
  withContextEngineOwner,
} from "./config-state.js";

type ActivationParams = Parameters<typeof resolveEffectivePluginActivationState>[0];
type Activation = ReturnType<typeof resolveEffectivePluginActivationState>;
const activation = (
  enabled: boolean,
  explicitlyEnabled: boolean,
  source: Activation["source"],
  reason?: string,
) => ({ enabled, activated: enabled, explicitlyEnabled, source, reason });
const entry = (id: string, enabled = true) => ({ entries: { [id]: { enabled } } });
const normalizeEntry = (value: Record<string, unknown>) =>
  normalizePluginsConfig({ entries: { "voice-call": value } }).entries["voice-call"];
afterEach(() => vi.restoreAllMocks());
function checkEnable(
  id: string,
  origin: "bundled" | "workspace",
  raw: Record<string, unknown>,
  expected: Activation,
) {
  const config = normalizePluginsConfig(raw);
  expect(resolveEnableState(id, origin, config)).toEqual(
    expected.enabled ? { enabled: true } : { enabled: false, reason: expected.reason },
  );
  expect(resolveEffectivePluginActivationState({ id, origin, config })).toEqual(expected);
}

describe("normalizePluginsConfig", () => {
  afterEach(clearRuntimeConfigSnapshot);
  it("replaces published policy and resumes mutable normalization after teardown", () => {
    setRuntimeConfigSnapshot({ plugins: entry("initial") });
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

  it("shares frozen policy only for deeply frozen plugin configs", () => {
    const frozen = freezeJsonSnapshot({
      entries: {
        "voice-call": {
          enabled: true,
          hooks: { timeouts: { before_agent_start: 1000 } },
          subagent: { allowedModels: ["example/model"] },
          llm: { allowedModels: ["example/model"], allowedCompletionModels: ["example/model"] },
        },
      },
    });
    const shared = normalizePluginsConfig(frozen);
    expect(normalizePluginsConfig(frozen)).toBe(shared);
    expect(Object.isFrozen(shared.entries["voice-call"])).toBe(true);
    const normalizedEntry = shared.entries["voice-call"]!;
    for (const policy of [normalizedEntry.hooks, normalizedEntry.subagent, normalizedEntry.llm]) {
      expect(Object.isFrozen(policy)).toBe(true);
      for (const value of Object.values(policy!)) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
    // Mutable sources can change in place, so every read normalizes again.
    const mutable = { entries: { "voice-call": { enabled: true } } };
    expect(normalizePluginsConfig(mutable)).not.toBe(normalizePluginsConfig(mutable));
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
        allowedModels: [" anthropic/claude-sonnet-4-6 ", "", 42, null, "openai/gpt-5.5"],
      },
      {
        allowModelOverride: true,
        hasAllowedModelsConfig: true,
        allowedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
      },
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
  });
});

describe("resolveEnableState", () => {
  it("uses declared non-channel ownership without discovering the bundled channel catalog", () => {
    const rootConfig: OpenClawConfig = {
      channels: { telegram: { enabled: false } },
      plugins: { entries: { helper: { enabled: true }, telegram: { enabled: true } } },
    };
    const catalog = vi.spyOn(bundledChannelCatalog, "listBundledChannelCatalogEntries");
    const activate = (id: string, channelIds?: string[]) =>
      resolveEffectivePluginActivationState({
        id,
        origin: "bundled",
        channelIds,
        config: normalizePluginsConfig(rootConfig.plugins),
        rootConfig,
      });
    expect(activate("helper", [])).toEqual(activation(true, true, "explicit", "enabled in config"));
    expect(catalog).not.toHaveBeenCalled();
    expect(activate("telegram", [])).toEqual(
      activation(true, true, "explicit", "enabled in config"),
    );
    for (const channelIds of [undefined, ["telegram"]]) {
      expect(activate("telegram", channelIds)).toMatchObject({
        enabled: false,
        reason: "channel disabled in config",
      });
    }
  });

  it("disables bundled plugins without explicit or default activation", () => {
    checkEnable(
      "openai",
      "bundled",
      {},
      activation(false, false, "disabled", "bundled (disabled by default)"),
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
      activation(
        enabled,
        true,
        enabled ? "explicit" : "disabled",
        enabled ? "selected memory slot" : "disabled in config",
      ),
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
      activation(true, true, "explicit", reason),
    );
  });
  it("does not let the default memory slot auto-enable an untrusted workspace plugin", () => {
    const reason = "workspace plugin (disabled by default)";
    checkEnable(
      "memory-core",
      "workspace",
      { slots: { memory: "memory-core" } },
      activation(false, true, "disabled", reason),
    );
  });
  it("keeps an explicitly selected workspace context engine enabled when omitted from plugins.allow", () => {
    checkEnable(
      "lossless-claw",
      "workspace",
      { allow: ["telegram"], slots: { contextEngine: "lossless-claw" } },
      activation(true, true, "explicit", "selected context engine slot"),
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

describe("context engine ownership", () => {
  const records = [
    { id: "vendor-plugin", contextEngineIds: ["Canonical-Engine", "second-engine"] },
    { id: "legacy-plugin" },
  ];
  const engineConfig = (
    contextEngine = "Canonical-Engine",
    policy: OpenClawConfig["plugins"] = {},
  ) => ({ plugins: { ...policy, slots: { contextEngine } } });
  const resolve = (policy: OpenClawConfig["plugins"] = {}, owners = records) =>
    resolveSelectedContextEnginePluginId(engineConfig("Canonical-Engine", policy), owners);
  const own = (contextEngine: string, policy: OpenClawConfig["plugins"], owners = records) =>
    withContextEngineOwner(
      normalizePluginsConfig(engineConfig(contextEngine, policy).plugins),
      owners,
    );
  const activate = (id: string, config: NonNullable<ActivationParams["config"]>) =>
    resolveEffectivePluginActivationState({ id, origin: "workspace", config });
  it("resolves exact declared engine IDs and preserves legacy equal-ID selection", () => {
    const resolveEngine = (contextEngine: string) =>
      resolveSelectedContextEnginePluginId(
        engineConfig(
          contextEngine,
          contextEngine !== "legacy-plugin" ? { allow: ["vendor-plugin"] } : {},
        ),
        records,
      );
    expect(resolveEngine("Canonical-Engine")).toBe("vendor-plugin");
    expect(resolveEngine("second-engine")).toBe("vendor-plugin");
    expect(resolveEngine("legacy-plugin")).toBe("legacy-plugin");
    expect(resolveEngine("vendor-plugin")).toBeUndefined();
  });
  it("carries ownership into activation without changing the engine slot", () => {
    const config = own("Canonical-Engine", { allow: ["vendor-plugin"] });
    expect(config.slots.contextEngine).toBe("Canonical-Engine");
    expect(activate("vendor-plugin", config).explicitlyEnabled).toBe(true);
    expect(activate("Canonical-Engine", config).enabled).toBe(false);
  });
  it("activates a mixed-case equal-ID owner from its canonical policy identity", () => {
    const config = own("MiXeD-demo", { allow: ["unrelated"] }, [
      { id: "MiXeD-demo", contextEngineIds: ["MiXeD-demo"] },
    ]);
    expect(config.contextEngineOwnerId).toBe("mixed-demo");
    expect(activate("MiXeD-demo", config)).toMatchObject({
      enabled: true,
      source: "explicit",
      reason: "selected context engine slot",
    });
  });
  it.each([
    { name: "default", normalizeId: undefined },
    { name: "exact supplied", normalizeId: (id: string) => id.trim() },
  ])("keeps exact selected owner with $name normalizer", ({ normalizeId }) => {
    const plugins = normalizePluginsConfig({
      allow: ["mixed-demo"],
      slots: { contextEngine: "canonical-engine" },
    });
    const mixedCaseRecords = [{ id: "MiXeD-demo", contextEngineIds: ["canonical-engine"] }];
    expect(
      resolveSelectedContextEnginePluginIdFromConfig(
        plugins,
        "canonical-engine",
        mixedCaseRecords,
        normalizeId,
      ),
    ).toBe("MiXeD-demo");
    expect(
      withContextEngineOwner(plugins, mixedCaseRecords, normalizeId).contextEngineOwnerId,
    ).toBe("mixed-demo");
  });
  it.each([false, true])(
    "retains both exact case-distinct eligible owners before import: declared=%s",
    (declared) => {
      const engineId = declared ? "canonical-engine" : "owner";
      const plugins = normalizePluginsConfig({
        allow: ["owner"],
        slots: { contextEngine: engineId },
      });
      const caseDistinctRecords = ["Owner", "owner"].map((id) =>
        declared ? { id, contextEngineIds: [engineId] } : { id },
      );
      expect(resolveEligibleContextEngineOwnerIds(plugins, engineId, caseDistinctRecords)).toEqual([
        "Owner",
        "owner",
      ]);
    },
  );
  it("does not choose a first owner or a same-named plugin over declared ownership", () => {
    const collision = [...records, { id: "other", contextEngineIds: ["Canonical-Engine"] }];
    expect(resolve({ allow: ["vendor-plugin"] }, [...records, { id: "canonical-engine" }])).toBe(
      "vendor-plugin",
    );
    expect(resolve({ allow: ["vendor-plugin"] }, collision)).toBe("vendor-plugin");
    expect(resolve({ allow: ["vendor-plugin", "other"] }, collision)).toBeUndefined();
  });
  it("does not fall back to an incidental equal-ID plugin when declared owners are ineligible", () => {
    expect(resolve({}, [...records, { id: "canonical-engine" }])).toBeUndefined();
  });
  it.each(["enabled", "allowlisted", "denied", "disabled", "incidental"] as const)(
    "requires independent approval for legacy fallback among ineligible declarations: %s",
    (policy) => {
      const plugins = normalizePluginsConfig({
        slots: { contextEngine: "legacy-plugin" },
        allow: policy === "allowlisted" ? ["legacy-plugin"] : ["unrelated"],
        ...(!["incidental", "allowlisted"].includes(policy)
          ? { entries: { "legacy-plugin": { enabled: policy !== "disabled" } } }
          : {}),
        ...(policy === "denied" ? { deny: ["legacy-plugin"] } : {}),
      });
      const resolved = withContextEngineOwner(plugins, [
        ...records,
        { id: "unapproved", contextEngineIds: ["legacy-plugin"] },
      ]);
      expect(resolved.contextEngineOwnerId).toBe(
        policy === "enabled" || policy === "allowlisted" ? "legacy-plugin" : null,
      );
    },
  );
  it("requires independent trust for a differently named declared owner", () => {
    expect(resolve()).toBeUndefined();
    expect(resolve(entry("vendor-plugin"))).toBe("vendor-plugin");
    expect(resolve({ allow: ["vendor-plugin"] })).toBe("vendor-plugin");
  });
  it.each([false, true])(
    "preserves equal-ID slot authorization outside an unrelated allowlist: declared=%s",
    (declared) => {
      const config = own(
        "legacy-plugin",
        { allow: ["unrelated"] },
        declared ? [{ id: "legacy-plugin", contextEngineIds: ["legacy-plugin"] }] : records,
      );
      expect(config.contextEngineOwnerId).toBe("legacy-plugin");
      expect(activate("legacy-plugin", config).enabled).toBe(true);
    },
  );
  it.each([
    { enabled: false },
    { deny: ["vendor-plugin"] },
    { entries: { "vendor-plugin": { enabled: false } } },
    { allow: ["Canonical-Engine"] },
  ])("applies owner policy %j", (policy) => {
    expect(resolve(policy)).toBeUndefined();
  });
});
