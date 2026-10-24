import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

// Registry tests script exports at module binding; real setup ownership stays active.
vi.mock("./plugin-instance-module-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-instance-module-loader.js")>();
  const { getCachedPluginModuleLoader } = await import("./plugin-module-loader-cache.js");
  return {
    ...actual,
    bindPluginInstanceModuleLoader: (
      params: Parameters<typeof actual.bindPluginInstanceModuleLoader>[0],
    ) =>
      params.instance.bindModuleLoader(
        getCachedPluginModuleLoader({
          modulePath: params.source,
          importerUrl: import.meta.url,
          tryNative: false,
          createLoader: getRegistryJitiMocks().createJiti,
        }),
      ),
  };
});

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

type SetupRegistryApi = import("./types.js").OpenClawPluginApi;
type ManifestRecord = import("./manifest-registry.js").PluginManifestRecord;

let clearPluginSetupRegistryCache: typeof import("./setup-registry.test-fixtures.js").clearPluginSetupRegistryCache;
let resolveRegistry: typeof import("./setup-registry.js").resolvePluginSetupRegistry;
let resolveProvider: typeof import("./setup-registry.js").resolvePluginSetupProviderCore;
let resolveBackend: typeof import("./setup-registry.js").resolvePluginSetupCliBackend;
let runMigrations: typeof import("./setup-registry.js").runPluginSetupConfigMigrations;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-setup-registry", tempDirs);
}

function fixture(fields: Pick<ManifestRecord, "id"> & Partial<ManifestRecord>) {
  const rootDir = fields.rootDir ?? makeTempDir();
  fs.writeFileSync(path.join(rootDir, "setup-api.js"), "export default {};\n");
  return { ...fields, rootDir };
}

function manifests(...plugins: ReturnType<typeof fixture>[]) {
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins, diagnostics: [] });
}

function setupPlugin(fields: Parameters<typeof fixture>[0]) {
  manifests(fixture(fields));
}

function backend(id: string, modelProvider: string | undefined, command: string) {
  return { id, ...(modelProvider ? { modelProvider } : {}), config: { command } };
}

const emptyRegistry = {
  providers: [],
  cliBackends: [],
  configMigrations: [],
  autoEnableProbes: [],
  diagnostics: [],
};

function diagnostic(code: string, pluginId: string, details: Record<string, unknown> = {}) {
  return { pluginId, code, ...details };
}

function registration(register: (api: SetupRegistryApi, source: string) => unknown) {
  mocks.createJiti.mockImplementation(() => (source: string) => ({
    default: { register: (api: SetupRegistryApi) => register(api, source) },
  }));
}

function contributions(api: SetupRegistryApi, label: string) {
  api.registerProvider({ id: "shared-provider", label, auth: [] });
  api.registerProvider({ id: "SHARED-PROVIDER", label: `${label} duplicate`, auth: [] });
  api.registerCliBackend(backend("shared-cli", "shared-provider", label));
  api.registerCliBackend(backend("SHARED-CLI", "shared-provider", `${label}-duplicate`));
  api.registerConfigMigration((config) => ({ config, changes: [label] }));
  api.registerAutoEnableProbe(() => label);
}

afterEach(() => {
  clearPluginSetupRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
});

beforeAll(async () => {
  resetRegistryJitiMocks();
  // A non-isolated sibling may have cached this owner before these hoisted mocks.
  vi.resetModules();
  ({
    resolvePluginSetupRegistry: resolveRegistry,
    resolvePluginSetupProviderCore: resolveProvider,
    resolvePluginSetupCliBackend: resolveBackend,
    runPluginSetupConfigMigrations: runMigrations,
  } = await import("./setup-registry.js"));
  ({ clearPluginSetupRegistryCache } = await import("./setup-registry.test-fixtures.js"));
});

beforeEach(() => {
  resetRegistryJitiMocks();
  clearPluginSetupRegistryCache();
});

describe("setup registry", () => {
  it("warns for setup-only CLI backends without modelProvider while retaining valid registrations", () => {
    setupPlugin({
      id: "acme-plugin",
      setup: { cliBackends: ["standalone-cli", "bound-cli"], requiresRuntime: true },
    });
    registration((api) => {
      expect(api.registrationMode).toBe("setup-only");
      api.registerCliBackend(backend("standalone-cli", undefined, "standalone"));
      api.registerCliBackend(backend("bound-cli", "acme", "bound"));
    });

    const registry = resolveRegistry({ env: {} });

    expect(registry.diagnostics).toEqual([
      diagnostic("setup-cli-backend-missing-model-provider", "acme-plugin", {
        runtimeId: "standalone-cli",
        message:
          'cli backend "standalone-cli" is missing modelProvider; provider-to-runtime binding will be skipped. Set modelProvider to the canonical model provider id to enable this binding.',
      }),
    ]);
    expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual([
      "standalone-cli",
      "bound-cli",
    ]);
  });

  it("ignores setup entries without a registration callback", () => {
    setupPlugin({ id: "empty" });
    expect(resolveRegistry({ pluginIds: ["empty"], env: {} })).toEqual(emptyRegistry);
  });

  it("uses provider auth aliases to route setup provider owner lookup", () => {
    setupPlugin({
      id: "openai",
      providerAuthAliases: { openai: "openai" },
      setup: { providers: [{ id: "openai" }], requiresRuntime: true },
    });
    registration((api) => {
      api.registerProvider({ id: "openai", aliases: ["openai"], label: "Legacy", auth: [] });
      api.registerProvider({
        id: "openai-current",
        hookAliases: ["openai"],
        label: "Current",
        auth: [],
      });
    });
    expect(resolveProvider({ provider: "openai", env: {} })).toMatchObject({
      id: "openai-current",
      label: "Current",
    });
  });

  it("treats explicit descriptor-only setup as a runtime cutoff", () => {
    setupPlugin({
      id: "openai",
      setup: { providers: [{ id: "openai" }], cliBackends: ["codex-cli"], requiresRuntime: false },
    });
    expect(resolveProvider({ provider: "openai", env: {} })).toBeUndefined();
    expect(resolveBackend({ backend: "codex-cli", env: {} })).toBeUndefined();
    expect(resolveRegistry({ env: {} })).toEqual({
      ...emptyRegistry,
      diagnostics: [
        diagnostic("setup-descriptor-runtime-disabled", "openai", { message: expect.any(String) }),
      ],
    });
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("reports undeclared runtime contributions and missing CLI backends", () => {
    setupPlugin({
      id: "openai",
      setup: { providers: [{ id: "openai" }], cliBackends: ["codex-cli"], requiresRuntime: true },
    });
    registration((api) => {
      api.registerProvider({ id: "anthropic", label: "Anthropic", auth: [] });
      api.registerCliBackend(backend("claude-cli", "anthropic", "claude"));
    });
    const registry = resolveRegistry({ env: {} });
    expect(registry.providers.map((entry) => entry.provider.id)).toEqual(["anthropic"]);
    expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["claude-cli"]);
    expect(registry.diagnostics).toMatchObject([
      diagnostic("setup-descriptor-provider-runtime-undeclared", "openai", {
        runtimeId: "anthropic",
      }),
      diagnostic("setup-descriptor-cli-backend-missing-runtime", "openai", {
        declaredId: "codex-cli",
      }),
      diagnostic("setup-descriptor-cli-backend-runtime-undeclared", "openai", {
        runtimeId: "claude-cli",
      }),
    ]);
  });

  it("does not load setup-api modules from the current working directory", () => {
    const rootDir = makeTempDir();
    const workspace = makeTempDir();
    // Match the old fallback's basename, so the shadow would actually be executable.
    const shadow = path.join(workspace, "extensions", path.basename(rootDir));
    fs.mkdirSync(shadow, { recursive: true });
    fs.writeFileSync(
      path.join(shadow, "setup-api.js"),
      "export default { register(api) { api.registerProvider({ id: 'openai', label: 'Shadow', auth: [] }); } };\n",
    );
    manifests({ id: "workspace-shadow", rootDir, setup: { providers: [{ id: "openai" }] } });
    {
      using cwd = vi.spyOn(process, "cwd");
      cwd.mockReturnValue(workspace);
      expect(resolveProvider({ provider: "openai", env: {} })).toBeUndefined();
    }
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "resolves setup CLI backends without rediscovery when prepared=%s",
    (prepared) => {
      const openai = fixture({
        id: "openai",
        cliBackends: ["legacy-openai-cli"],
        setup: { cliBackends: ["codex-cli"], requiresRuntime: true },
      });
      const plugins = [openai, fixture({ id: "anthropic", cliBackends: ["claude-cli"] })];
      manifests(...plugins);
      const metadataSnapshot = prepared
        ? createPluginMetadataSnapshotFixture({ plugins })
        : undefined;
      if (prepared) {
        mocks.loadPluginManifestRegistry.mockImplementation(() => {
          throw new Error("Prepared CLI lookup must not rediscover manifests");
        });
      }
      registration((api, source) =>
        api.registerCliBackend(
          source.includes(openai.rootDir)
            ? backend("codex-cli", "openai", "codex")
            : backend("claude-cli", undefined, "claude"),
        ),
      );
      const expected = {
        pluginId: "openai",
        backend: { id: "codex-cli", modelProvider: "openai", config: { command: "codex" } },
      };
      const lookup = (id: string) => resolveBackend({ backend: id, env: {}, metadataSnapshot });
      expect(lookup("codex-cli")).toEqual(expected);
      expect(lookup("codex-cli")).toEqual(expected);
      expect(lookup("legacy-openai-cli")).toBeUndefined();
      expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    },
  );

  it("reports unavailable setup runtime access with the plugin id and registration mode", () => {
    setupPlugin({ id: "runtime-dependent-setup" });
    registration((api) =>
      api.runtime.state.openSyncKeyedStore({ namespace: "example", maxEntries: 1 }),
    );
    expect(resolveRegistry({ env: {} }).diagnostics).toMatchObject([
      diagnostic("setup-registration-failed", "runtime-dependent-setup", {
        message: expect.stringContaining(
          'Plugin "runtime-dependent-setup" runtime is intentionally unavailable during "setup-only" registration.',
        ),
      }),
    ]);
  });

  it("publishes each plugin setup registration atomically without leaked warnings", () => {
    const setup = { providers: [{ id: "shared-provider" }], cliBackends: ["shared-cli"] };
    const throwing = fixture({ id: "shared-plugin", setup });
    manifests(throwing, fixture({ id: "shared-plugin", setup }));
    const throwingRegister = vi.fn((api: SetupRegistryApi) => {
      api.registerCliBackend(backend("shared-cli", undefined, "throwing"));
      contributions(api, "throwing");
      throw new Error("setup registration failed");
    });
    const healthyRegister = vi.fn((api: SetupRegistryApi) => contributions(api, "healthy"));
    registration((api, source) =>
      (source.includes(throwing.rootDir) ? throwingRegister : healthyRegister)(api),
    );
    const first = resolveRegistry();
    const second = resolveRegistry();
    const healthyBackend = backend("shared-cli", "shared-provider", "healthy");
    for (const registry of [first, second]) {
      expect(registry.providers).toMatchObject([
        { pluginId: "shared-plugin", provider: { id: "shared-provider", label: "healthy" } },
      ]);
      expect(registry.cliBackends).toEqual([
        { pluginId: "shared-plugin", backend: healthyBackend },
      ]);
      expect(registry.configMigrations).toHaveLength(1);
      expect(registry.configMigrations[0]?.migrate({})?.changes).toEqual(["healthy"]);
      expect(registry.autoEnableProbes).toHaveLength(1);
      expect(registry.autoEnableProbes[0]?.probe({ config: {}, env: {} })).toBe("healthy");
      expect(registry.diagnostics).toMatchObject([
        diagnostic("setup-registration-failed", "shared-plugin"),
      ]);
    }
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    expect(throwingRegister).toHaveBeenCalledTimes(1);
    expect(healthyRegister).toHaveBeenCalledTimes(1);
  });

  it("ignores late contributions and handles rejected async registration", async () => {
    setupPlugin({ id: "async-plugin" });
    registration((api) => {
      contributions(api, "sync");
      return Promise.resolve().then(() => {
        api.registerProvider({ id: "async-provider", label: "Async", auth: [] });
        api.registerCliBackend(backend("async-cli", undefined, "async"));
        api.registerConfigMigration((config) => ({ config, changes: ["async"] }));
        api.registerAutoEnableProbe(() => "async");
        throw new Error("async registration rejected");
      });
    });
    const first = resolveRegistry();
    await Promise.resolve();
    await Promise.resolve();
    const second = resolveRegistry();
    for (const registry of [first, second]) {
      expect(registry.providers.map((entry) => entry.provider.id)).toEqual(["shared-provider"]);
      expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["shared-cli"]);
      expect(registry.configMigrations).toHaveLength(1);
      expect(registry.autoEnableProbes).toHaveLength(1);
    }
  });

  it.each(["provider", "cliBackend"])(
    "rejects ambiguous setup %s owners before executing code",
    (kind) => {
      manifests(
        ...["bundled", "workspace"].map((origin) =>
          fixture({
            id: origin === "bundled" ? "openai" : "workspace-shadow",
            origin: origin === "bundled" ? "bundled" : "workspace",
            setup:
              kind === "provider"
                ? { providers: [{ id: origin === "bundled" ? "openai" : "OpenAI" }] }
                : { cliBackends: [origin === "bundled" ? "codex-cli" : "CODEX-CLI"] },
          }),
        ),
      );
      expect(
        kind === "provider"
          ? resolveProvider({ provider: "openai", env: {} })
          : resolveBackend({ backend: "codex-cli", env: {} }),
      ).toBeUndefined();
      expect(mocks.createJiti).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("isolates registered migration candidates (throws=%s)", (throws) => {
    setupPlugin({ id: "fixture" });
    registration((api) => {
      api.registerConfigMigration((config) => ({
        config: { ...config, gateway: { port: 18789 } },
        changes: ["first"],
      }));
      api.registerConfigMigration((config) => {
        config.gateway = { port: 19999 };
        if (throws) {
          throw new Error("fixture migration failed");
        }
        return null;
      });
      api.registerConfigMigration((config) => ({
        config: { ...config, gateway: { ...config.gateway, bind: "loopback" } },
        changes: ["last"],
      }));
    });
    const config = { plugins: { entries: { fixture: {} } } };
    const result = runMigrations({ config, env: {} });

    expect(result.config.gateway).toEqual({ port: 18789, bind: "loopback" });
    expect(result.changes).toEqual(["first", "last"]);
    expect(result.warnings ?? []).toEqual(
      throws ? [expect.stringContaining('Plugin "fixture" config repair failed')] : [],
    );
    expect(config).toEqual({ plugins: { entries: { fixture: {} } } });
  });
});
