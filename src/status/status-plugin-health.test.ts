import { expect, it } from "vitest";
import {
  formatCompactPluginHealthLine as compact,
  formatDetailedPluginHealth as detailed,
  mergeStatusPluginHealthSnapshots as merge,
  type PluginHealthRecord,
  type StatusPluginHealthSnapshot,
} from "./status-plugin-health.js";

const snapshot = (patch: Partial<StatusPluginHealthSnapshot> = {}): StatusPluginHealthSnapshot => ({
  plugins: [],
  diagnostics: [],
  contextEngineQuarantines: [],
  ...patch,
});
const plugin = (id: string, patch: Partial<PluginHealthRecord> = {}): PluginHealthRecord => ({
  id,
  status: "loaded",
  enabled: true,
  ...patch,
});
const disabled = (id: string, error?: string) =>
  plugin(id, { status: "disabled", enabled: false, error });
const detail = (patch: Partial<StatusPluginHealthSnapshot>) => detailed(snapshot(patch));
const expectLines = (text: string, lines: string[]) =>
  expect(text.split("\n")).toEqual(expect.arrayContaining(lines));
const channelDiagnostic = {
  level: "error",
  pluginId: "broken-channel",
  code: "channel-setup-failure",
  message: "setup failed",
} as const;
const diagnosticFailure = {
  channelId: "broken-channel",
  pluginId: "broken-channel",
  message: "setup failed",
  source: "diagnostic",
};
const warning = {
  pluginId: "legacy",
  severity: "warn",
  code: "hook-only",
  message: "compatibility",
} as const;

function health(count: number): StatusPluginHealthSnapshot {
  const ids = Array.from({ length: count }, (_, i) => count - i - 1);
  return snapshot({
    plugins: [
      ...ids.map((i) =>
        plugin(`error-${i}`, {
          status: "error",
          error: i ? `load ${i}` : undefined,
          failurePhase: i === 1 ? "load" : undefined,
        }),
      ),
      ...ids.map((i) =>
        plugin(`dependency-${i}`, {
          status: i ? undefined : "loaded",
          dependencyStatus: {
            hasDependencies: true,
            requiredInstalled: false,
            missing: i ? [`package-${i}`] : undefined,
          },
        }),
      ),
    ],
    diagnostics: [
      { level: "warn", message: "warning first" },
      { level: "error", pluginId: "diagnostic", message: "error second" },
    ],
    contextEngineQuarantines: ids.map((i) => ({
      engineId: `engine-${i}`,
      operation: "bootstrap",
      reason: `context ${i}`,
      failedAt: 0,
      owner: i === 1 ? "plugin:engine" : undefined,
    })),
    runtimeToolQuarantines: ids.map((i) => ({
      toolName: `tool-${i}`,
      reason: `schema ${i}`,
      failedAt: 0,
      owner: i === 1 ? "plugin:tools" : undefined,
    })),
    channelPluginFailures: ids.map((i) => ({
      channelId: `channel-${i}`,
      message: `setup ${i}`,
      pluginId: i === 1 ? "channel-plugin" : undefined,
      source: i === 1 ? "setup" : undefined,
    })),
    compatibilityNotices: ids.map((i) => ({
      pluginId: `compat-${i}`,
      severity: i ? "warn" : "info",
      message: `compatibility ${i}`,
      code: i === 1 ? "hook-only" : undefined,
    })),
  });
}

it("renders a bounded, sorted report with default and optional fields after merging health", () => {
  const input = health(9);
  const disabledPlugins = [
    ...Array.from({ length: 10 }, (_, i) => disabled(`default-${i}`)),
    disabled("zeta", "reason 0"),
    disabled("alpha", "reason 0"),
    ...Array.from({ length: 7 }, (_, i) => disabled(`reason-plugin-${i + 1}`, `reason ${i + 1}`)),
  ];
  const installed = snapshot({ plugins: disabledPlugins, compatibilityNotices: [warning] });
  const original = structuredClone({ input, installed });
  const result = merge(installed, input);
  const originalResult = structuredClone(result);
  expect(detailed(result)).toBe(
    [
      "⚠️ Plugins: 9 plugin errors · 9 context engine quarantines · 9 runtime tool quarantines · 9 channel plugin failures · 9 dependency issues · 1 diagnostic error",
      "Loaded: 1 (dependency-0)",
      "Disabled: 19",
      "- disabled: 10 (default-0, default-1, default-2, default-3, default-4, default-5, default-6, default-7, +2 more)",
      "- reason 0: 2 (alpha, zeta)",
      ...Array.from({ length: 6 }, (_, i) => `- reason ${i + 1}: 1 (reason-plugin-${i + 1})`),
      "- +1 more reasons",
      "Errors: 9",
      "- error-0: failed to load",
      "- error-1 [load]: load 1",
      ...Array.from({ length: 6 }, (_, i) => `- error-${i + 2}: load ${i + 2}`),
      "Context engine quarantines: 9",
      "- engine-0 during bootstrap: context 0",
      "- engine-1 owner=plugin:engine during bootstrap: context 1",
      ...Array.from(
        { length: 6 },
        (_, i) => `- engine-${i + 2} during bootstrap: context ${i + 2}`,
      ),
      "Runtime tool quarantines: 9",
      "- tool-0: schema 0",
      "- tool-1 owner=plugin:tools: schema 1",
      ...Array.from({ length: 6 }, (_, i) => `- tool-${i + 2}: schema ${i + 2}`),
      "Channel plugin failures: 9",
      "- channel-0: setup 0",
      "- channel-1 plugin=channel-plugin [setup]: setup 1",
      ...Array.from({ length: 6 }, (_, i) => `- channel-${i + 2}: setup ${i + 2}`),
      "Dependency issues: 9",
      "- dependency-0: missing required dependencies",
      ...Array.from({ length: 7 }, (_, i) => `- dependency-${i + 1}: missing package-${i + 1}`),
      "Diagnostics: 1 errors · 1 warnings",
      "- WARN warning first",
      "- ERROR diagnostic: error second",
      "Compatibility notices: 10",
      "- INFO compat-0: compatibility 0",
      "- WARN compat-1 [hook-only]: compatibility 1",
      ...Array.from({ length: 6 }, (_, i) => `- WARN compat-${i + 2}: compatibility ${i + 2}`),
      "Full inventory: /plugins list",
    ].join("\n"),
  );
  expect({ input, installed }).toEqual(original);
  expect(result).toEqual(originalResult);
  expect(result.compatibilityNotices).toContainEqual(warning);
});

it("uses singular counts for each compact health category", () => {
  expect(compact(health(1))).toBe(
    "⚠️ Plugins: 1 plugin error · 1 context engine quarantine · 1 runtime tool quarantine · 1 channel plugin failure · 1 dependency issue · 1 diagnostic error",
  );
});

it("renders healthy empty status and keeps compatibility notices out of compact problems", () => {
  expect(detailed(snapshot())).toBe(
    "🔌 Plugins: OK\nLoaded: 0\nDisabled: 0\nFull inventory: /plugins list",
  );
  expect(compact(snapshot({ compatibilityNotices: [warning] }))).toBeUndefined();
});

it.each([true, false])(
  "counts channel diagnostics only without a matching failure (matched=%s)",
  (matched) => {
    expect(
      compact(
        snapshot({
          diagnostics: [channelDiagnostic],
          channelPluginFailures: matched ? [diagnosticFailure] : [],
        }),
      ),
    ).toBe(matched ? "⚠️ Plugins: 1 channel plugin failure" : "⚠️ Plugins: 1 diagnostic error");
  },
);

it.each<[Partial<StatusPluginHealthSnapshot>, string[], string[]]>([
  [
    {
      plugins: [
        plugin("runtime-ok"),
        plugin("installed-idle"),
        plugin("broken", { status: "error", failurePhase: "load", error: "boom" }),
        disabled("off"),
      ],
      runtimeLoadedPluginIds: ["runtime-ok"],
    },
    [
      "Loaded: 1 (runtime-ok)",
      "Installed (not active): 1 (installed-idle)",
      "Disabled: 1",
      "- broken [load]: boom",
    ],
    ["Loaded: 2", "Configured to run but not loaded:"],
  ],
  [{ plugins: [plugin("a"), plugin("b")] }, ["Loaded: 2 (a, b)"], ["Installed (not active):"]],
  [
    { plugins: [plugin("active-ok")], runtimeLoadedPluginIds: ["active-ok", "pinned-only"] },
    ["Loaded: 2 (active-ok, pinned-only)"],
    ["Installed (not active):"],
  ],
  [
    {
      plugins: ["runtime-ok", "planned-missing", "not-planned-idle"].map((id) => plugin(id)),
      runtimeLoadedPluginIds: ["runtime-ok"],
      shouldRunPluginIds: ["planned-missing", "runtime-ok"],
    },
    [
      "Loaded: 1 (runtime-ok)",
      "Configured to run but not loaded: 1 (planned-missing)",
      "Installed (not active): 1 (not-planned-idle)",
    ],
    [],
  ],
  [
    {
      plugins: [
        plugin("runtime-ok"),
        plugin("broken", { status: "error", failurePhase: "load", error: "boom" }),
        disabled("off"),
      ],
      runtimeLoadedPluginIds: ["runtime-ok"],
      shouldRunPluginIds: ["broken", "off", "runtime-ok"],
    },
    ["- broken [load]: boom", "Disabled: 1"],
    ["Configured to run but not loaded:"],
  ],
])("classifies inventory %j", (input, present, absent) => {
  const text = detail(input);
  expectLines(text, present);
  for (const line of absent) {
    expect(text).not.toContain(line);
  }
});

it("keeps installed-only loaded plugins out of Loaded after merge", () => {
  const merged = merge(
    snapshot({ plugins: [plugin("installed-idle")] }),
    snapshot({ plugins: [plugin("runtime-ok")], runtimeLoadedPluginIds: ["runtime-ok"] }),
  );
  expect(merged.runtimeLoadedPluginIds).toEqual(["runtime-ok"]);
  expectLines(detailed(merged), [
    "Loaded: 1 (runtime-ok)",
    "Installed (not active): 1 (installed-idle)",
  ]);
});

it("flags configured memory embedding providers that no loaded plugin registers", () => {
  const text = detail({
    plugins: [plugin("runtime-ok")],
    runtimeLoadedPluginIds: ["runtime-ok"],
    unregisteredMemoryEmbeddingProviders: [
      { configuredId: "custom-embed", source: "provider" },
      { configuredId: "fallback-embed", source: "fallback" },
    ],
  });
  expect(text).toContain(
    "Configured memory provider not registered: 2 (custom-embed (memorySearch.provider), fallback-embed (memorySearch.fallback))",
  );
  expect(text.split("\n")[0]).toBe("🔌 Plugins: OK");
});

it.each([undefined, []])(
  "omits the memory-provider line with %j",
  (unregisteredMemoryEmbeddingProviders) => {
    expect(
      detail({
        plugins: [plugin("runtime-ok")],
        runtimeLoadedPluginIds: ["runtime-ok"],
        unregisteredMemoryEmbeddingProviders,
      }),
    ).not.toContain("Configured memory provider not registered:");
  },
);
