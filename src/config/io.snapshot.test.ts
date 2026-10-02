import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as doctorLegacy from "../commands/doctor/shared/legacy-config-issues.js";
import * as channelPresence from "../plugins/channel-presence-policy.js";
import * as manifestRegistry from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import {
  readConfigFileSnapshotFromContext,
  readConfigFileSnapshotWithPluginMetadataFromContext,
  readBestEffortConfigSnapshotFromContext,
} from "./io.snapshot.js";
import {
  cloneConfigWithResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
} from "./resolution-facts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

function createContext(root: string, configPath = path.join(root, "openclaw.json")) {
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  return createConfigIoContext({
    configPath,
    env,
    homedir: () => root,
    observe: false,
  });
}

describe("config snapshot plugin metadata", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retains an inaccessible config parent as a read failure rather than a missing config",
    async () => {
      const root = tempDirs.make("openclaw-config-inaccessible-parent-");
      const parent = path.join(root, "restricted");
      fs.mkdirSync(parent);
      const configPath = path.join(parent, "openclaw.json");
      const source = '{"gateway":{"mode":"local"}}';
      fs.writeFileSync(configPath, source);
      const context = createContext(root, configPath);
      context.options.pluginValidation = "core-only";
      fs.chmodSync(parent, 0);
      try {
        expect(fs.existsSync(configPath)).toBe(false);
        const snapshot = await readConfigFileSnapshotFromContext(context);
        expect(snapshot).toMatchObject({
          valid: false,
          raw: null,
          readError: { code: "EACCES" },
          issues: [{ errorCode: "CONFIG_READ_FAILED" }],
        });
      } finally {
        fs.chmodSync(parent, 0o700);
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(source);
    },
  );

  it("preserves source paths across core-only and prepared plugin reads with a Windows home", async () => {
    const root = tempDirs.make("openclaw-config-windows-paths-");
    const context = createContext(root);
    const windowsHome = "C:\\Users\\fixture";
    const resolve = path.resolve;
    const resolveWindows = path.win32.resolve;
    vi.spyOn(path, "resolve").mockImplementation((...segments) =>
      segments.some((segment) => segment.startsWith(windowsHome))
        ? resolveWindows(...segments)
        : resolve(...segments),
    );
    context.pathResolution = { env: {}, homedir: () => windowsHome };
    const plugins = {
      enabled: false,
      entries: { wiki: { config: { store: { path: "~/.openclaw/wiki" } } } },
    };
    fs.writeFileSync(context.configPath, JSON.stringify({ plugins }));
    context.options.pluginValidation = "core-only";
    const core = await readConfigFileSnapshotFromContext(context);
    context.options.pluginValidation = "full";
    const { snapshot: full } = await readConfigFileSnapshotWithPluginMetadataFromContext(context, {
      prepareValidation: "runtime",
    });

    expect(core.valid).toBe(true);
    expect(full.valid).toBe(true);
    expect(core.sourceConfig).toEqual(full.sourceConfig);
    for (const snapshot of [core, full]) {
      expect(snapshot.authoredConfig?.plugins).toEqual(plugins);
      expect(snapshot.sourceConfig.plugins).toEqual(plugins);
      expect(snapshot.sourceConfigBeforeMigrations?.plugins).toEqual(plugins);
      expect(snapshot.runtimeConfig.plugins?.entries?.wiki?.config).toEqual({
        store: { path: "C:\\Users\\fixture\\.openclaw\\wiki" },
      });
    }
  });

  it.each([
    { useInclude: false, invalid: true },
    { useInclude: true, invalid: false },
  ])(
    "pairs authored references with their resolved read (include: $useInclude, invalid: $invalid)",
    async ({ useInclude, invalid }) => {
      const root = tempDirs.make("openclaw-config-authored-snapshot-");
      const context = createContext(root);
      context.deps.env.PLUGIN_TOKEN = "read-time-token";
      const plugins = {
        enabled: false,
        entries: { retired: { config: { token: "${PLUGIN_TOKEN}" } } },
      };
      fs.writeFileSync(path.join(root, "plugins.json"), JSON.stringify(plugins));
      fs.writeFileSync(
        context.configPath,
        JSON.stringify({
          gateway: { auth: { token: "${PLUGIN_TOKEN}" } },
          plugins: useInclude ? { $include: "plugins.json" } : plugins,
          ...(invalid ? { nodeHost: { browserProxy: { enabled: "invalid" } } } : {}),
        }),
      );

      const snapshot = await readConfigFileSnapshotFromContext(context);
      const hash = snapshot.hash;
      context.deps.env.PLUGIN_TOKEN = "later-token";
      fs.writeFileSync(path.join(root, "plugins.json"), "{}");

      expect(snapshot.valid).toBe(!invalid);
      expect(snapshot.authoredConfig?.plugins).toEqual(plugins);
      expect(snapshot.authoredConfig?.gateway?.auth?.token).toBe("${PLUGIN_TOKEN}");
      expect(snapshot.sourceConfigBeforeMigrations?.gateway?.auth?.token).toBe("read-time-token");
      expect(snapshot.sourceConfigBeforeMigrations?.plugins?.entries?.retired?.config).toEqual({
        token: "read-time-token",
      });
      expect(snapshot.parsed).toMatchObject({
        plugins: useInclude ? { $include: "plugins.json" } : plugins,
      });
      expect(snapshot.hash).toBe(hash);
      expect(snapshot.path).toBe(context.configPath);
    },
  );

  it.each(["full", "core-only"] as const)(
    "leaves legacy roster repair to Doctor during %s validation",
    async (pluginValidation) => {
      const root = tempDirs.make("openclaw-config-roster-metadata-");
      const context = createContext(root);
      context.options.pluginValidation = pluginValidation;
      const agents = { list: [{ id: "primary", default: true }, { id: "secondary" }] };
      fs.writeFileSync(
        context.configPath,
        JSON.stringify({
          agents,
          channels: { discord: { enabled: false } },
        }),
      );
      const discovery = vi.spyOn(channelPresence, "listChannelIdsForOwnershipMigration");
      const snapshot = await readConfigFileSnapshotFromContext(context);
      expect(snapshot.valid).toBe(false);
      expect(snapshot.sourceConfig.agents).toEqual(agents);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({
          path: "agents.list",
          message: expect.stringContaining("doctor --fix"),
        }),
      );
      expect(discovery).not.toHaveBeenCalled();
    },
  );

  it.each(["full", "core-only"] as const)(
    "keeps invalid snapshot Doctor contracts owned by %s validation",
    async (pluginValidation) => {
      const root = tempDirs.make("openclaw-config-invalid-metadata-");
      const context = createContext(root);
      context.options.pluginValidation = pluginValidation;
      fs.writeFileSync(
        context.configPath,
        JSON.stringify({
          nodeHost: { browserProxy: { enabled: "invalid" } },
          channels: { discord: {} },
          session: { typingMode: "thinking" },
        }),
      );
      const doctor = vi.spyOn(doctorLegacy, "findDoctorLegacyConfigIssues");
      const snapshot = await readConfigFileSnapshotFromContext(context);
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "nodeHost.browserProxy.enabled" }),
        ]),
      );
      expect(snapshot.legacyIssues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "session.typingMode" })]),
      );
      expect(doctor.mock.calls.length > 0).toBe(pluginValidation === "full");
    },
  );

  it("keeps best-effort core-only materialization independent of plugin metadata", async () => {
    const root = tempDirs.make("openclaw-config-best-effort-metadata-");
    const context = createContext(root);
    context.options.pluginValidation = "core-only";
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        models: {
          providers: {
            "fixture-external": {
              baseUrl: "https://example.test/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      }),
    );
    const discovery = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore");
    const result = await readBestEffortConfigSnapshotFromContext(context);
    expect(result.configDiagnostics).toBeNull();
    expect(result.config.models?.providers?.["fixture-external"]?.baseUrl).toBe(
      "https://example.test/v1",
    );
    expect(result.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect(discovery).not.toHaveBeenCalled();
  });
  it("records only genuinely missing substitutions as private facts", async () => {
    const root = tempDirs.make("openclaw-config-snapshot-env-facts-");
    const context = createContext(root);
    context.deps.env.GATEWAY_TOKEN = "${ENV_LITERAL_GATEWAY_TOKEN}";
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        gateway: {
          auth: {
            mode: "password",
            password: "${MISSING_GATEWAY_PASSWORD}",
            token: "$${ESCAPED_GATEWAY_TOKEN}",
          },
          remote: { token: "${GATEWAY_TOKEN}", password: "literal-${" },
        },
        hooks: { token: "$MISSING_HOOK_TOKEN" },
      }),
      "utf8",
    );

    const snapshot = await readConfigFileSnapshotFromContext(context);

    expect([...(getConfigResolutionFacts(snapshot.sourceConfigBeforeMigrations) ?? [])]).toEqual([
      "gateway.auth.password",
    ]);
    expect(snapshot.config.gateway?.auth?.token).toBe("${ESCAPED_GATEWAY_TOKEN}");
    expect(snapshot.config.gateway?.remote?.token).toBe("${ENV_LITERAL_GATEWAY_TOKEN}");
    expect(snapshot.config.gateway?.remote?.password).toBe("literal-${");
    expect(getAuthoredConfigSecretRef(snapshot.config, "hooks.token")).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_HOOK_TOKEN",
    });
    expect(getAuthoredConfigSecretRef(snapshot.config, "gateway.auth.password")?.id).toBe(
      "MISSING_GATEWAY_PASSWORD",
    );
    expect(getAuthoredConfigSecretRef(snapshot.config, "gateway.auth.token")).toBeNull();
    expect(getAuthoredConfigSecretRef(snapshot.config, "gateway.remote.token")).toBeNull();
    expect(
      getAuthoredConfigSecretRef(cloneConfigWithResolutionFacts(snapshot.config), "hooks.token")
        ?.id,
    ).toBe("MISSING_HOOK_TOKEN");
    expect(JSON.stringify(snapshot)).not.toContain("resolutionFacts");
  });

  it("loads metadata for an explicit valid missing-config read without changing plain reads", async () => {
    const root = tempDirs.make("openclaw-config-snapshot-metadata-");
    const context = createContext(root);
    const loader = vi.spyOn(context, "createValidationPluginMetadataSnapshotLoader");

    const plainSnapshot = await readConfigFileSnapshotFromContext(context);

    expect(plainSnapshot).toMatchObject({ exists: false, valid: true });
    expect(loader.mock.results.every(({ value }) => value.getSnapshot() === undefined)).toBe(true);

    const result = await readConfigFileSnapshotWithPluginMetadataFromContext(context);

    expect(result.snapshot).toMatchObject({ exists: false, valid: true });
    expect(structuredClone(result.pluginMetadataSnapshot?.manifestRegistry)).toEqual(
      result.pluginMetadataSnapshot?.manifestRegistry,
    );
    expect(result.pluginMetadataSnapshot?.configFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.pluginMetadataSnapshot?.index).toMatchObject({
      version: 1,
      hostContractVersion: expect.any(String),
      plugins: expect.any(Array),
    });
  });

  it("does not invent plugin metadata for invalid snapshots", async () => {
    const root = tempDirs.make("openclaw-config-snapshot-invalid-");
    const context = createContext(root);
    fs.writeFileSync(context.configPath, "{ invalid", "utf8");
    const loader = vi.spyOn(context, "createValidationPluginMetadataSnapshotLoader");

    const result = await readConfigFileSnapshotWithPluginMetadataFromContext(context);

    expect(result.snapshot.valid).toBe(false);
    expect(result.snapshot.authoredConfig).toBeUndefined();
    expect(result.pluginMetadataSnapshot).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });
});
