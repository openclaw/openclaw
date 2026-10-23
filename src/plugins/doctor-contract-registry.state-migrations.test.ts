import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useDoctorContractRegistryHarness } from "./doctor-contract-registry.test-harness.js";

const harness = useDoctorContractRegistryHarness({ legacySetup: true, waitForRetirement: true });
const { mocks, warn: doctorContractWarnMock, makeTempDir } = harness;

function mockDoctorPlugins(...plugins: Record<string, unknown>[]): void {
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins, diagnostics: [] });
}

const workspaceActivation = [
  { name: "inactive workspace", config: {}, allowed: false },
  { name: "allowlisted workspace", config: { plugins: { allow: ["alpha"] } }, allowed: true },
  {
    name: "enabled workspace",
    config: { plugins: { entries: { alpha: { enabled: true } } } },
    allowed: true,
  },
];

function pluginRecord(rootDir: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "alpha",
    origin: "bundled",
    rootDir,
    channels: [],
    providers: [],
    doctorContract: { stateMigrations: true },
    ...overrides,
  };
}

function migrationEntries(
  options: Parameters<typeof harness.registry.listPluginDoctorStateMigrationEntries>[0] = {},
) {
  return harness.registry.listPluginDoctorStateMigrationEntries({
    config: {},
    env: {},
    ...options,
  });
}

function migrationIds(options: Parameters<typeof migrationEntries>[0] = {}) {
  return migrationEntries(options).map((entry) => entry.migration.id);
}

const directDetector = `module.exports = {
  kind: "bundled-channel-setup-entry",
  features: { legacyStateMigrations: true },
  loadSetupPlugin() { record("activation"); throw new Error("setup plugin activated"); },
  loadLegacyStateMigrationDetector() { record("detector"); return () => []; },
};`;

function writeMigrations(root: string, ...ids: string[]) {
  fs.writeFileSync(
    path.join(root, "doctor-contract-api.cjs"),
    `module.exports = { stateMigrations: [${ids
      .map(
        (id) => `{
    id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)},
    detectLegacyState: () => null,
    migrateLegacyState: () => ({ changes: [], warnings: [] }),
  }`,
      )
      .join(",")} ] };\n`,
  );
}

function detectionInput(stateDir: string, oauthDir = stateDir) {
  return {
    config: {},
    env: {},
    stateDir,
    oauthDir,
    context: {
      openPluginStateKeyedStore: () => {
        throw new Error("legacy detection must not open plugin state");
      },
    },
  };
}

function legacyFixture(
  source: string,
  overrides: Record<string, unknown> = {},
  extension: "cjs" | "ts" = "cjs",
) {
  const pluginRoot = makeTempDir();
  const setupSource = path.join(pluginRoot, `setup-entry.${extension}`);
  const eventsPath = path.join(pluginRoot, "legacy-setup-events.log");
  fs.writeFileSync(
    setupSource,
    [
      extension === "ts"
        ? 'import { appendFileSync } from "node:fs";'
        : 'const { appendFileSync } = require("node:fs");',
      `const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");`,
      'record("module");',
      source,
    ].join("\n"),
  );
  mockDoctorPlugins(
    pluginRecord(pluginRoot, {
      id: "legacy-channel",
      origin: "global",
      setupSource,
      channels: ["legacy-channel"],
      doctorContract: undefined,
      ...overrides,
    }),
  );
  return {
    pluginRoot,
    events: () =>
      fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8").trim().split("\n") : [],
  };
}

function mockModernPlugin(overrides: Record<string, unknown>, configRepair = false) {
  const root = makeTempDir();
  const detectLegacyState = vi.fn(() => ({ preview: ["alpha state"] }));
  const migrateLegacyState = vi.fn(() => ({
    changes: configRepair ? ["migrated alpha state"] : [],
    warnings: [],
  }));
  fs.writeFileSync(path.join(root, "doctor-contract-api.ts"), "export {};\n", "utf8");
  mocks.createJiti.mockImplementation(() => () => ({
    legacyConfigRules: configRepair
      ? [{ path: ["channels", "alpha", "legacy"], message: "repair disabled alpha" }]
      : [],
    stateMigrations: [
      {
        id: "alpha-state",
        label: "Alpha state",
        detectLegacyState,
        migrateLegacyState,
      },
    ],
  }));
  mockDoctorPlugins(pluginRecord(root, overrides));
  return { detectLegacyState, migrateLegacyState };
}

function modernLegacyFixture(source = directDetector) {
  return legacyFixture(source, {
    id: "alpha",
    channels: ["alpha"],
    doctorContract: { stateMigrations: true },
    packageManifest: { setupFeatures: { legacyStateMigrations: true } },
  });
}

describe("doctor-contract-registry state migrations", () => {
  it("freezes dynamic and declared live actions in stable owner order", () => {
    const pluginRoot = makeTempDir();
    writeMigrations(pluginRoot, "dynamic-action");
    mockDoctorPlugins(
      pluginRecord(pluginRoot, { id: "dynamic-owner" }),
      pluginRecord(pluginRoot, {
        id: "declared-owner",
        doctorContract: { stateMigrations: [{ id: "declared-action" }] },
      }),
    );

    expect(
      harness.registry.resolveLivePluginDoctorStateMigrationInventory({ config: {}, env: {} })
        .descriptors,
    ).toEqual([
      { pluginId: "declared-owner", id: "declared-action" },
      { pluginId: "dynamic-owner", id: "dynamic-action" },
    ]);
  });

  it("uses stable owner order while preserving each owner's declaration order", () => {
    const acpxRoot = makeTempDir();
    const codexRoot = makeTempDir();
    writeMigrations(acpxRoot, "z-prepare", "a-finalize");
    writeMigrations(codexRoot, "codex-only");
    const codexRecord = pluginRecord(codexRoot, {
      id: "codex",
      origin: "config",
      doctorContract: { stateMigrations: [{ id: "codex-only" }] },
    });
    const acpxRecord = pluginRecord(acpxRoot, {
      id: "acpx",
      doctorContract: {
        stateMigrations: [{ id: "z-prepare" }, { id: "a-finalize" }],
      },
    });
    let discoveryOrder = [codexRecord, acpxRecord];
    mocks.loadPluginManifestRegistry.mockImplementation(() => ({
      plugins: discoveryOrder,
      diagnostics: [],
    }));
    const expected = [
      { pluginId: "acpx", id: "z-prepare" },
      { pluginId: "acpx", id: "a-finalize" },
      { pluginId: "codex", id: "codex-only" },
    ];
    expect(
      harness.registry.resolveLivePluginDoctorStateMigrationInventory({ config: {}, env: {} })
        .descriptors,
    ).toEqual(expected);

    discoveryOrder = [acpxRecord, codexRecord];
    expect(
      migrationEntries().map(({ pluginId, migration }) => ({
        pluginId,
        id: migration.id,
      })),
    ).toEqual(expected);
  });

  it("loads a direct legacy detector without package or entry feature hints", async () => {
    const { events } = legacyFixture(
      `export default {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() { record("activation"); throw new Error("setup plugin activated"); },
  loadLegacyStateMigrationDetector() {
    record("detector");
    return ({ oauthDir }: { oauthDir: string }) => {
      record("detect");
      return [{ kind: "move", label: "Legacy credentials",
        sourcePath: oauthDir + "/legacy.json", targetPath: oauthDir + "/demo/legacy.json" }];
    };
  },
};`,
      {},
      "ts",
    );

    expect(
      migrationEntries({
        config: { channels: { "legacy-channel": { enabled: false } } },
        pluginIds: ["legacy-channel"],
      }),
    ).toEqual([]);
    expect(events()).toEqual([]);

    const entries = migrationEntries({ pluginIds: ["legacy-channel"] });

    expect(entries).toMatchObject([{ pluginId: "legacy-channel" }]);
    await expect(
      entries[0]?.migration.detectLegacyState(detectionInput("/state", "/oauth")),
    ).resolves.toEqual({
      preview: ["- Legacy credentials: /oauth/legacy.json → /oauth/demo/legacy.json"],
    });
    expect(events()).toEqual(["module", "detector", "detect"]);
    expect(doctorContractWarnMock).not.toHaveBeenCalled();
  });

  it.each(["stateless", "detector", "invalid-detector", "foreign-owner"] as const)(
    "inspects the public setup entry without dropping %s migration obligations",
    (kind) => {
      legacyFixture(
        `module.exports = { plugin: {
          id: ${JSON.stringify(kind === "foreign-owner" ? "other-channel" : "legacy-channel")},
          ${kind === "detector" ? "lifecycle: { detectLegacyStateMigrations: () => [] }," : ""}
          ${kind === "invalid-detector" ? "lifecycle: { detectLegacyStateMigrations: true }," : ""}
        } };`,
      );
      const stateless = vi.fn();
      const entries = migrationEntries({
        pluginIds: ["legacy-channel"],
        onInspectedStatelessPlugin: stateless,
      });
      expect(entries).toHaveLength(kind === "detector" ? 1 : 0);
      expect(stateless).not.toHaveBeenCalled();
      expect(doctorContractWarnMock).toHaveBeenCalledTimes(kind === "invalid-detector" ? 1 : 0);
    },
  );

  it.each([false, true])(
    "gates the legacy setup-plugin lifecycle fallback (entry feature=%s)",
    async (entryFeature) => {
      const { pluginRoot, events } = legacyFixture(
        `module.exports = {
  kind: "bundled-channel-setup-entry",
  ${entryFeature ? "features: { legacyStateMigrations: true }," : ""}
  loadSetupPlugin() {
    record("setup-plugin");
    return { lifecycle: { detectLegacyStateMigrations() { record("detect"); return []; } } };
  },
};`,
      );
      const entries = migrationEntries({ pluginIds: ["legacy-channel"] });
      expect(entries).toHaveLength(Number(entryFeature));
      if (entries[0]) {
        await expect(
          entries[0].migration.detectLegacyState(detectionInput(pluginRoot)),
        ).resolves.toBeNull();
      }
      expect(events()).toEqual(entryFeature ? ["module", "setup-plugin", "detect"] : ["module"]);
      expect(doctorContractWarnMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "wrong kind", kind: "bundled-channel-entry", includeSetupLoader: true },
    {
      name: "missing required setup loader",
      kind: "bundled-channel-setup-entry",
      includeSetupLoader: false,
    },
  ])("rejects a legacy setup entry with $name", ({ kind, includeSetupLoader }) => {
    const { events } = legacyFixture(
      `module.exports = {
  kind: ${JSON.stringify(kind)},
  features: { legacyStateMigrations: true },
  ${includeSetupLoader ? 'loadSetupPlugin() { record("activation"); throw new Error("setup plugin activated"); },' : ""}
  loadLegacyStateMigrationDetector() { record("detector"); return () => []; },
};`,
      { packageManifest: { setupFeatures: { legacyStateMigrations: true } } },
    );

    expect(migrationEntries()).toEqual([]);
    expect(events()).toEqual(["module"]);
    expect(doctorContractWarnMock).not.toHaveBeenCalled();
  });

  it.each([
    { channels: { alpha: { enabled: false } } },
    { plugins: { entries: { alpha: { enabled: false } } } },
    { plugins: { deny: ["alpha"] } },
    { plugins: { enabled: false } },
    { channels: { alpha: { enabled: false }, "alpha-alias": { enabled: false } } },
  ])("repairs disabled owner config without loading state migrations: %j", (config) => {
    const { detectLegacyState, migrateLegacyState } = mockModernPlugin(
      {
        origin: "global",
        channels: ["alpha", "alpha-alias"],
        doctorContract: { configRepair: true, stateMigrations: true },
      },
      true,
    );

    expect(migrationEntries({ config })).toEqual([]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
    expect(harness.registry.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([
      { path: ["channels", "alpha", "legacy"], message: "repair disabled alpha" },
    ]);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(migrationIds({ config, includeDisabled: true })).toEqual(["alpha-state"]);
    expect(detectLegacyState).not.toHaveBeenCalled();
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it.each([
    ...workspaceActivation.map((scenario) => ({ ...scenario, origin: "workspace" })),
    {
      name: "non-bundled owner omitted from a restrictive allowlist",
      origin: "global",
      config: { plugins: { allow: ["other-plugin"] } },
      allowed: false,
    },
  ])("honors effective activation before loading an $name", ({ origin, config, allowed }) => {
    const { events } = legacyFixture(directDetector, {
      id: "alpha",
      origin,
      channels: ["alpha"],
      packageManifest: { setupFeatures: { legacyStateMigrations: true } },
    });

    expect(migrationIds({ config, pluginIds: ["alpha"] })).toEqual(
      allowed ? ["alpha-legacy-channel-state"] : [],
    );
    expect(events()).toEqual(allowed ? ["module", "detector"] : []);
    expect(doctorContractWarnMock).not.toHaveBeenCalled();
  });

  it.each(workspaceActivation)(
    "gates a modern non-channel $name before loading",
    ({ config, allowed }) => {
      mockModernPlugin({ origin: "workspace" });

      expect(migrationIds({ config })).toEqual(allowed ? ["alpha-state"] : []);
      expect(mocks.createJiti).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("preserves an enabled channel alias and the existing restrictive-allowlist bypass", () => {
    const pluginRoot = makeTempDir();
    writeMigrations(pluginRoot, "alpha-state");
    mockDoctorPlugins(pluginRecord(pluginRoot, { channels: ["alpha", "alpha-alias"] }));

    expect(
      migrationIds({
        config: {
          channels: { alpha: { enabled: false }, "alpha-alias": { enabled: true } },
          plugins: { allow: ["unrelated"] },
        },
      }),
    ).toEqual(["alpha-state"]);
  });

  it("prefers modern migrations without loading the same owner's legacy setup entry", () => {
    const { pluginRoot, events } = modernLegacyFixture(
      "throw new Error('obsolete setup entry loaded');",
    );
    writeMigrations(pluginRoot, "alpha-modern");
    expect(migrationIds()).toEqual(["alpha-modern"]);
    expect(events()).toEqual([]);
    expect(doctorContractWarnMock).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy when an explicit modern declaration yields no migrations", () => {
    const { pluginRoot, events } = modernLegacyFixture();
    writeMigrations(pluginRoot);

    expect(migrationEntries()).toEqual([]);
    expect(events()).toEqual([]);
    expect(doctorContractWarnMock).not.toHaveBeenCalled();
  });

  it("keeps bundled non-channel state migrations available when plugins are globally disabled", () => {
    const pluginRoot = makeTempDir();
    writeMigrations(pluginRoot, "memory-state");
    mockDoctorPlugins(pluginRecord(pluginRoot, { id: "memory-state" }));

    expect(migrationIds({ config: { plugins: { enabled: false } } })).toEqual(["memory-state"]);
  });
});
