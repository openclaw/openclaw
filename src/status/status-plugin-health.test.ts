import { expect, it } from "vitest";
import {
  formatCompactPluginHealthLine as compact,
  formatDetailedPluginHealth as detailed,
  mergeStatusPluginHealthSnapshots as merge,
  type BlockedPluginHookRecord,
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
  expect(detail({ unregisteredMemoryEmbeddingProviders: [] })).toBe(
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

const blockedHook = (patch: Partial<BlockedPluginHookRecord> = {}): BlockedPluginHookRecord => ({
  pluginId: "openclaw-beads",
  hookName: "before_prompt_build",
  reason: "conversation-access-missing",
  severity: "error",
  message: "was NOT registered",
  ...patch,
});

it("counts implicitly blocked hooks in the compact line but not operator-chosen ones", () => {
  expect(compact(snapshot({ blockedHooks: [blockedHook()] }))).toBe("⚠️ Plugins: 1 blocked hook");

  // A hook the operator deliberately denied is steady state, not a problem.
  expect(
    compact(
      snapshot({
        blockedHooks: [
          blockedHook({
            pluginId: "chatty-plugin",
            reason: "prompt-injection-denied",
            severity: "warn",
            message: "blocked by plugins.entries.chatty-plugin.hooks.allowPromptModification=false",
          }),
        ],
      }),
    ),
  ).toBeUndefined();
});

it("lists blocked hooks in detailed health without double-reporting their diagnostic", () => {
  const message =
    'typed hook "before_prompt_build" from non-bundled plugin "openclaw-beads" was NOT registered: ' +
    "set plugins.entries.openclaw-beads.hooks.allowConversationAccess to true";
  const text = detail({
    diagnostics: [
      { level: "error", pluginId: "openclaw-beads", code: "hook-registration-blocked", message },
    ],
    blockedHooks: [blockedHook({ message })],
  });

  expect(text).toContain("Blocked plugin hooks: 1");
  expect(text).toContain(
    `- ERROR openclaw-beads before_prompt_build [conversation-access-missing]: ${message}`,
  );
  // The diagnostic is the same fact; it must not also appear in Diagnostics.
  expect(text).not.toContain("Diagnostics:");
  expect(text).toContain("⚠️ Plugins: 1 blocked hook");
});

it("still reports a hook-blocked diagnostic that has no matching blocked-hook record", () => {
  const text = detail({
    diagnostics: [
      {
        level: "error",
        pluginId: "ghost-plugin",
        code: "hook-registration-blocked",
        message: "orphaned blocked-hook diagnostic",
      },
    ],
  });

  expect(text).toContain("Diagnostics: 1 errors · 0 warnings");
  expect(text).toContain("- ERROR ghost-plugin: orphaned blocked-hook diagnostic");
  expect(text).not.toContain("Blocked plugin hooks:");
});

it("caps the blocked hook list and reports the overflow", () => {
  const text = detail({
    blockedHooks: Array.from({ length: 10 }, (_unused, index) =>
      blockedHook({
        pluginId: `plugin-${index}`,
        hookName: "agent_end",
        message: `blocked ${index}`,
      }),
    ),
  });

  expect(text).toContain("Blocked plugin hooks: 10");
  expect(text).toContain("- +2 more blocked hooks");
});

it("keeps repeat registrations of one hook distinct through the merge", () => {
  // A plugin may call api.on() for the same hook several times (distinct
  // registrationId, priority or trigger eligibility). When the policy refuses
  // them, every one of those handlers is dead, so plugin+hook+reason is not a
  // unique key. Deduping on it made the merged detailed view under-count them
  // while compact status read the raw runtime records and counted them all.
  const blocked = blockedHook({
    pluginId: "repeat-hooks",
    hookName: "before_agent_reply",
    message: 'typed hook "before_agent_reply" was NOT registered',
  });
  const runtime = snapshot({ blockedHooks: [blocked, blocked] });

  const merged = merge(snapshot(), runtime);

  expect(merged.blockedHooks).toStrictEqual([blocked, blocked]);
  // The two surfaces must report the same number of dead handlers.
  expect(compact(merged)).toBe("⚠️ Plugins: 2 blocked hooks");
  expect(compact(runtime)).toBe(compact(merged));
  expect(detailed(merged)).toContain("Blocked plugin hooks: 2");
});

it("does not double-count a single blocked hook through the merge", () => {
  // The merge concatenates both sides; the installed disk scan never attempts
  // registration, so a lone runtime refusal must stay exactly one row.
  const merged = merge(
    snapshot(),
    snapshot({ blockedHooks: [blockedHook({ pluginId: "single-hook" })] }),
  );

  expect(merged.blockedHooks).toHaveLength(1);
  expect(compact(merged)).toBe("⚠️ Plugins: 1 blocked hook");
  expect(detailed(merged)).toContain("Blocked plugin hooks: 1");
});

it("uses installed loaded status only without runtime provenance", () => {
  const text = detail({ plugins: [plugin("a"), plugin("b")] });
  expect(text).toContain("Loaded: 2 (a, b)");
  expect(text).not.toContain("Installed (not active):");
});

it("classifies runtime, installed, missing and failed plugins after merge", () => {
  const merged = merge(
    snapshot({ plugins: [plugin("installed-idle"), plugin("planned-missing")] }),
    snapshot({
      plugins: [
        plugin("runtime-ok"),
        disabled("off"),
        plugin("broken", { status: "error", failurePhase: "load", error: "boom" }),
      ],
      runtimeLoadedPluginIds: ["runtime-ok", "pinned-only"],
    }),
  );
  expect(merged.runtimeLoadedPluginIds).toEqual(["runtime-ok", "pinned-only"]);
  const text = detailed({
    ...merged,
    shouldRunPluginIds: ["runtime-ok", "planned-missing", "off", "broken"],
  });
  expectLines(text, [
    "Loaded: 2 (pinned-only, runtime-ok)",
    "Installed (not active): 1 (installed-idle)",
    "Configured to run but not loaded: 1 (planned-missing)",
    "Disabled: 1",
    "- broken [load]: boom",
  ]);
  expect(detailed(merged)).not.toContain("Configured to run but not loaded:");
});

it("flags configured memory embedding providers that no loaded plugin registers", () => {
  const text = detail({
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
