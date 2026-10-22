import { describe, expect, it } from "vitest";
import {
  formatCompactPluginHealthLine,
  formatDetailedPluginHealth,
  mergeStatusPluginHealthSnapshots,
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
const detail = (patch: Partial<StatusPluginHealthSnapshot>) =>
  formatDetailedPluginHealth(snapshot(patch));
const expectLines = (text: string, lines: string[]) =>
  expect(text.split("\n")).toEqual(expect.arrayContaining(lines));
const expectedSection = (label: string, entry: (index: number) => string) => [
  `${label}: 9`,
  ...Array.from({ length: 8 }, (_, index) => `- ${entry(index)}`),
];
const channelDiagnostic = {
  level: "error",
  pluginId: "broken-channel",
  code: "channel-setup-failure",
  message: "setup failed",
} as const;

describe("plugin health status formatting", () => {
  it("renders the exact detailed status when every health section is empty", () => {
    expect(detail({})).toBe(
      "🔌 Plugins: OK\nLoaded: 0\nDisabled: 0\nFull inventory: /plugins list",
    );
  });

  it("keeps mixed health sections, default text, and diagnostic order without changing input", () => {
    const input = snapshot({
      plugins: [
        plugin("broken-default", { status: "error" }),
        plugin("needs-default", {
          dependencyStatus: { hasDependencies: true, requiredInstalled: false },
        }),
      ],
      diagnostics: [
        { level: "warn", message: "warning first" },
        { level: "error", pluginId: "diagnostic-plugin", message: "error second" },
      ],
      contextEngineQuarantines: [
        { engineId: "engine-a", operation: "bootstrap", reason: "context failed", failedAt: 0 },
      ],
      runtimeToolQuarantines: [{ toolName: "tool-a", reason: "schema failed", failedAt: 0 }],
      channelPluginFailures: [{ channelId: "channel-a", message: "setup failed" }],
      compatibilityNotices: [
        { pluginId: "compat-a", severity: "info", message: "compatibility active" },
      ],
    });
    const original = structuredClone(input);
    expect(formatDetailedPluginHealth(input)).toBe(
      [
        "⚠️ Plugins: 1 plugin error · 1 context engine quarantine · 1 runtime tool quarantine · 1 channel plugin failure · 1 dependency issue · 1 diagnostic error",
        "Loaded: 1 (needs-default)",
        "Disabled: 0",
        "Errors: 1",
        "- broken-default: failed to load",
        "Context engine quarantines: 1",
        "- engine-a during bootstrap: context failed",
        "Runtime tool quarantines: 1",
        "- tool-a: schema failed",
        "Channel plugin failures: 1",
        "- channel-a: setup failed",
        "Dependency issues: 1",
        "- needs-default: missing required dependencies",
        "Diagnostics: 1 errors · 1 warnings",
        "- WARN warning first",
        "- ERROR diagnostic-plugin: error second",
        "Compatibility notices: 1",
        "- INFO compat-a: compatibility active",
        "Full inventory: /plugins list",
      ].join("\n"),
    );
    expect(input).toEqual(original);
  });

  it("reports full counts but renders only the first eight sorted entries in each health section", () => {
    const ids = Array.from({ length: 9 }, (_, index) => String(8 - index));
    const input = snapshot({
      plugins: [
        ...ids.map((id) => plugin(`error-${id}`, { status: "error", error: `load ${id}` })),
        ...ids.map((id) =>
          plugin(`dependency-${id}`, {
            status: undefined,
            dependencyStatus: {
              hasDependencies: true,
              requiredInstalled: false,
              missing: [`package-${id}`],
            },
          }),
        ),
      ],
      contextEngineQuarantines: ids.map((id) => ({
        engineId: `engine-${id}`,
        operation: "bootstrap",
        reason: `context ${id}`,
        failedAt: 0,
      })),
      runtimeToolQuarantines: ids.map((id) => ({
        toolName: `tool-${id}`,
        reason: `tool ${id}`,
        failedAt: 0,
      })),
      channelPluginFailures: ids.map((id) => ({
        channelId: `channel-${id}`,
        message: `channel ${id}`,
      })),
      compatibilityNotices: ids.map((id) => ({
        pluginId: `compat-${id}`,
        severity: "warn",
        message: `compatibility ${id}`,
      })),
    });
    const original = structuredClone(input);
    expect(formatDetailedPluginHealth(input)).toBe(
      [
        "⚠️ Plugins: 9 plugin errors · 9 context engine quarantines · 9 runtime tool quarantines · 9 channel plugin failures · 9 dependency issues",
        "Loaded: 0",
        "Disabled: 0",
        ...expectedSection("Errors", (i) => `error-${i}: load ${i}`),
        ...expectedSection(
          "Context engine quarantines",
          (i) => `engine-${i} during bootstrap: context ${i}`,
        ),
        ...expectedSection("Runtime tool quarantines", (i) => `tool-${i}: tool ${i}`),
        ...expectedSection("Channel plugin failures", (i) => `channel-${i}: channel ${i}`),
        ...expectedSection("Dependency issues", (i) => `dependency-${i}: missing package-${i}`),
        ...expectedSection("Compatibility notices", (i) => `WARN compat-${i}: compatibility ${i}`),
        "Full inventory: /plugins list",
      ].join("\n"),
    );
    expect(input).toEqual(original);
  });

  it.each([true, false])(
    "counts channel diagnostics only without a matching failure (matched=%s)",
    (matched) => {
      expect(
        formatCompactPluginHealthLine(
          snapshot({
            diagnostics: [channelDiagnostic],
            channelPluginFailures: matched
              ? [
                  {
                    channelId: "broken-channel",
                    pluginId: "broken-channel",
                    message: "setup failed",
                    source: "diagnostic",
                  },
                ]
              : [],
          }),
        ),
      ).toBe(matched ? "⚠️ Plugins: 1 channel plugin failure" : "⚠️ Plugins: 1 diagnostic error");
    },
  );

  it("keeps compatibility notices out of the compact problem line", () => {
    expect(
      formatCompactPluginHealthLine(
        snapshot({
          compatibilityNotices: [
            {
              pluginId: "legacy-plugin",
              severity: "warn",
              code: "hook-only",
              message: "uses a compatibility shim",
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("merges runtime health into installed plugin snapshots for detailed status", () => {
    const broken = plugin("runtime-broken", {
      status: "error",
      failurePhase: "load",
      error: "runtime load failed",
    });
    const failure = {
      channelId: "runtime-broken",
      pluginId: "runtime-broken",
      message: "setup failed",
      source: "diagnostic",
    };
    const notice = {
      pluginId: "compat-only",
      severity: "warn",
      code: "hook-only",
      message: "is hook-only",
    } as const;
    const merged = mergeStatusPluginHealthSnapshots(
      snapshot({ plugins: [plugin("installed-ok")], compatibilityNotices: [notice] }),
      snapshot({
        plugins: [broken],
        diagnostics: [{ ...channelDiagnostic, pluginId: "runtime-broken" }],
        runtimeToolQuarantines: [
          {
            toolName: "bad_tool",
            owner: "plugin:bad-tools",
            reason: "unsupported schema",
            failedAt: new Date(789),
          },
        ],
        channelPluginFailures: [failure],
      }),
    );
    expect(merged.plugins).toContainEqual(broken);
    expect(merged.runtimeToolQuarantines).toHaveLength(1);
    expect(merged.channelPluginFailures).toContainEqual(failure);
    expect(merged.compatibilityNotices).toContainEqual(notice);
  });

  it("includes detailed plugin state without dumping the full plugin registry", () => {
    expectLines(
      detail({
        plugins: [
          plugin("ok-plugin"),
          disabled("disabled-plugin"),
          plugin("bad-plugin", { status: "error", failurePhase: "load", error: "module failed" }),
        ],
        diagnostics: [{ level: "warn", pluginId: "bad-plugin", message: "deprecated hook" }],
        runtimeToolQuarantines: [
          {
            toolName: "bad_tool",
            owner: "plugin:bad-tools",
            reason: "unsupported anyOf",
            failedAt: new Date(0),
          },
        ],
        channelPluginFailures: [
          { channelId: "sms", pluginId: "sms-plugin", message: "setup failed", source: "setup" },
        ],
        compatibilityNotices: [
          {
            pluginId: "legacy-plugin",
            severity: "warn",
            code: "hook-only",
            message: "uses a compatibility shim",
          },
        ],
      }),
      [
        "⚠️ Plugins: 1 plugin error · 1 runtime tool quarantine · 1 channel plugin failure",
        "Loaded: 1 (ok-plugin)",
        "Disabled: 1",
        "- disabled: 1 (disabled-plugin)",
        "- bad-plugin [load]: module failed",
        "- bad_tool owner=plugin:bad-tools: unsupported anyOf",
        "- sms plugin=sms-plugin [setup]: setup failed",
        "Diagnostics: 0 errors · 1 warnings",
        "- WARN legacy-plugin [hook-only]: uses a compatibility shim",
        "Full inventory: /plugins list",
      ],
    );
  });

  it("groups disabled plugins by their recorded disable reason", () => {
    const lines = detail({
      plugins: [
        disabled("zeta", "not in allowlist"),
        disabled("alpha", "overridden by better-alpha plugin"),
        disabled("beta", "not in allowlist"),
        disabled("mid"),
      ],
    }).split("\n");
    const index = lines.indexOf("Disabled: 4");
    expect(index).toBeGreaterThan(-1);
    expect(lines.slice(index + 1, index + 4)).toEqual([
      "- disabled: 1 (mid)",
      "- not in allowlist: 2 (beta, zeta)",
      "- overridden by better-alpha plugin: 1 (alpha)",
    ]);
  });

  it("caps disabled reason lines and per-reason id lists", () => {
    const distinct = detail({
      plugins: Array.from({ length: 9 }, (_, i) => disabled(`plugin-${i}`, `reason ${i}`)),
    });
    expectLines(distinct, ["Disabled: 9", "- reason 7: 1 (plugin-7)", "- +1 more reasons"]);
    expect(distinct).not.toContain("reason 8");
    expectLines(
      detail({
        plugins: Array.from({ length: 10 }, (_, i) => disabled(`plugin-${i}`, "not in allowlist")),
      }),
      [
        "Disabled: 10",
        "- not in allowlist: 10 (plugin-0, plugin-1, plugin-2, plugin-3, plugin-4, plugin-5, plugin-6, plugin-7, +2 more)",
      ],
    );
  });

  it.each([
    {
      name: "runtime provenance separates installed inventory",
      plugins: [
        plugin("runtime-ok"),
        plugin("installed-idle"),
        plugin("broken", { status: "error", failurePhase: "load", error: "boom" }),
        disabled("off"),
      ],
      runtimeLoadedPluginIds: ["runtime-ok"],
      present: [
        "Loaded: 1 (runtime-ok)",
        "Installed (not active): 1 (installed-idle)",
        "Disabled: 1",
        "- broken [load]: boom",
      ],
      absent: ["Loaded: 2", "Configured to run but not loaded:"],
    },
    {
      name: "absent provenance falls back to status-loaded",
      plugins: [plugin("a"), plugin("b")],
      present: ["Loaded: 2 (a, b)"],
      absent: ["Installed (not active):"],
    },
    {
      name: "pinned runtime plugins need no installed record",
      plugins: [plugin("active-ok")],
      runtimeLoadedPluginIds: ["active-ok", "pinned-only"],
      present: ["Loaded: 2 (active-ok, pinned-only)"],
      absent: ["Installed (not active):"],
    },
    {
      name: "startup drift is separate from neutral inventory",
      plugins: ["runtime-ok", "planned-missing", "not-planned-idle"].map((id) => plugin(id)),
      runtimeLoadedPluginIds: ["runtime-ok"],
      shouldRunPluginIds: ["planned-missing", "runtime-ok"],
      present: [
        "Loaded: 1 (runtime-ok)",
        "Configured to run but not loaded: 1 (planned-missing)",
        "Installed (not active): 1 (not-planned-idle)",
      ],
      absent: [],
    },
    {
      name: "error and disabled records already explain startup absence",
      plugins: [
        plugin("runtime-ok"),
        plugin("broken", { status: "error", failurePhase: "load", error: "boom" }),
        disabled("off"),
      ],
      runtimeLoadedPluginIds: ["runtime-ok"],
      shouldRunPluginIds: ["broken", "off", "runtime-ok"],
      present: ["- broken [load]: boom", "Disabled: 1"],
      absent: ["Configured to run but not loaded:"],
    },
  ])("$name", ({ name: _name, present, absent, ...input }) => {
    const text = detail(input);
    expectLines(text, present);
    for (const line of absent) {
      expect(text).not.toContain(line);
    }
  });

  it("keeps installed-only loaded plugins out of Loaded after merge", () => {
    const merged = mergeStatusPluginHealthSnapshots(
      snapshot({ plugins: [plugin("installed-idle")] }),
      snapshot({ plugins: [plugin("runtime-ok")], runtimeLoadedPluginIds: ["runtime-ok"] }),
    );
    expect(merged.runtimeLoadedPluginIds).toEqual(["runtime-ok"]);
    expectLines(formatDetailedPluginHealth(merged), [
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
});
