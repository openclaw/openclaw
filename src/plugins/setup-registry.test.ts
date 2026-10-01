import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
let resolvePluginSetupRegistry: typeof import("./setup-registry.js").resolvePluginSetupRegistry;
let resolvePluginSetupProviderCore: typeof import("./setup-registry.js").resolvePluginSetupProviderCore;
let resolvePluginSetupCliBackend: typeof import("./setup-registry.js").resolvePluginSetupCliBackend;

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

function registration(register: (api: SetupRegistryApi, source: string) => unknown) {
  mocks.createJiti.mockImplementation(() => (source: string) => ({
    default: { register: (api: SetupRegistryApi) => register(api, source) },
  }));
}

function contributions(api: SetupRegistryApi, label: string) {
  api.registerProvider({ id: "shared-provider", label, auth: [] });
  api.registerProvider({ id: "SHARED-PROVIDER", label: `${label} duplicate`, auth: [] });
  api.registerCliBackend({ id: "shared-cli", config: { command: label } });
  api.registerCliBackend({ id: "SHARED-CLI", config: { command: `${label}-duplicate` } });
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
  ({ resolvePluginSetupRegistry, resolvePluginSetupProviderCore, resolvePluginSetupCliBackend } =
    await import("./setup-registry.js"));
  ({ clearPluginSetupRegistryCache } = await import("./setup-registry.test-fixtures.js"));
});

beforeEach(() => {
  resetRegistryJitiMocks();
  clearPluginSetupRegistryCache();
});

describe("setup registry", () => {
  it("ignores setup entries without a registration callback", () => {
    manifests(fixture({ id: "empty" }));
    expect(resolvePluginSetupRegistry({ pluginIds: ["empty"], env: {} })).toEqual({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });
  });

  it("uses provider auth aliases to route setup provider owner lookup", () => {
    manifests(
      fixture({
        id: "openai",
        providerAuthAliases: { openai: "openai" },
        setup: { providers: [{ id: "openai" }], requiresRuntime: true },
      }),
    );
    registration((api) => {
      api.registerProvider({ id: "openai", aliases: ["openai"], label: "Legacy", auth: [] });
      api.registerProvider({
        id: "openai-current",
        hookAliases: ["openai"],
        label: "Current",
        auth: [],
      });
    });
    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toMatchObject({
      id: "openai-current",
      label: "Current",
    });
  });

  it("treats explicit descriptor-only setup as a runtime cutoff", () => {
    manifests(
      fixture({
        id: "openai",
        setup: {
          providers: [{ id: "openai" }],
          cliBackends: ["codex-cli"],
          requiresRuntime: false,
        },
      }),
    );
    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toBeUndefined();
    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toBeUndefined();
    expect(resolvePluginSetupRegistry({ env: {} })).toEqual({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [
        {
          pluginId: "openai",
          code: "setup-descriptor-runtime-disabled",
          message: expect.any(String),
        },
      ],
    });
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("reports undeclared runtime contributions and missing CLI backends", () => {
    manifests(
      fixture({
        id: "openai",
        setup: { providers: [{ id: "openai" }], cliBackends: ["codex-cli"], requiresRuntime: true },
      }),
    );
    registration((api) => {
      api.registerProvider({ id: "anthropic", label: "Anthropic", auth: [] });
      api.registerCliBackend({ id: "claude-cli", config: { command: "claude" } });
    });
    const registry = resolvePluginSetupRegistry({ env: {} });
    expect(registry.providers.map((entry) => entry.provider.id)).toEqual(["anthropic"]);
    expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["claude-cli"]);
    expect(registry.diagnostics).toMatchObject([
      {
        pluginId: "openai",
        code: "setup-descriptor-provider-runtime-undeclared",
        runtimeId: "anthropic",
      },
      {
        pluginId: "openai",
        code: "setup-descriptor-cli-backend-missing-runtime",
        declaredId: "codex-cli",
      },
      {
        pluginId: "openai",
        code: "setup-descriptor-cli-backend-runtime-undeclared",
        runtimeId: "claude-cli",
      },
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
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workspace);
    try {
      expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("resolves setup cli backends from descriptors without loading every setup-api", () => {
    const openai = fixture({
      id: "openai",
      cliBackends: ["legacy-openai-cli"],
      setup: { cliBackends: ["codex-cli"], requiresRuntime: true },
    });
    manifests(openai, fixture({ id: "anthropic", cliBackends: ["claude-cli"] }));
    registration((api, source) =>
      api.registerCliBackend(
        source.includes(openai.rootDir)
          ? { id: "codex-cli", config: { command: "codex" } }
          : { id: "claude-cli", config: { command: "claude" } },
      ),
    );
    const expected = {
      pluginId: "openai",
      backend: { id: "codex-cli", config: { command: "codex" } },
    };
    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toEqual(expected);
    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toEqual(expected);
    expect(resolvePluginSetupCliBackend({ backend: "legacy-openai-cli", env: {} })).toBeUndefined();
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable setup runtime access with the plugin id and registration mode", () => {
    manifests(fixture({ id: "runtime-dependent-setup" }));
    registration((api) =>
      api.runtime.state.openSyncKeyedStore({ namespace: "example", maxEntries: 1 }),
    );
    expect(resolvePluginSetupRegistry({ env: {} }).diagnostics).toMatchObject([
      {
        pluginId: "runtime-dependent-setup",
        code: "setup-registration-failed",
        message: expect.stringContaining(
          'Plugin "runtime-dependent-setup" runtime is intentionally unavailable during "setup-only" registration.',
        ),
      },
    ]);
  });

  it("publishes each plugin setup registration atomically on synchronous success", () => {
    const setup = { providers: [{ id: "shared-provider" }], cliBackends: ["shared-cli"] };
    const throwing = fixture({ id: "shared-plugin", setup });
    manifests(throwing, fixture({ id: "shared-plugin", setup }));
    const throwingRegister = vi.fn((api: SetupRegistryApi) => {
      contributions(api, "throwing");
      throw new Error("setup registration failed");
    });
    const healthyRegister = vi.fn((api: SetupRegistryApi) => contributions(api, "healthy"));
    registration((api, source) =>
      (source.includes(throwing.rootDir) ? throwingRegister : healthyRegister)(api),
    );
    const first = resolvePluginSetupRegistry();
    const second = resolvePluginSetupRegistry();
    for (const registry of [first, second]) {
      expect(registry.providers).toMatchObject([
        { pluginId: "shared-plugin", provider: { id: "shared-provider", label: "healthy" } },
      ]);
      expect(registry.cliBackends).toEqual([
        {
          pluginId: "shared-plugin",
          backend: { id: "shared-cli", config: { command: "healthy" } },
        },
      ]);
      expect(registry.configMigrations).toHaveLength(1);
      expect(registry.configMigrations[0]?.migrate({})?.changes).toEqual(["healthy"]);
      expect(registry.autoEnableProbes).toHaveLength(1);
      expect(registry.autoEnableProbes[0]?.probe({ config: {}, env: {} })).toBe("healthy");
      expect(registry.diagnostics).toMatchObject([
        { pluginId: "shared-plugin", code: "setup-registration-failed" },
      ]);
    }
    expect(second).not.toBe(first);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    expect(throwingRegister).toHaveBeenCalledTimes(1);
    expect(healthyRegister).toHaveBeenCalledTimes(1);
  });

  it("ignores late contributions and handles rejected async registration", async () => {
    manifests(fixture({ id: "async-plugin" }));
    registration((api) => {
      contributions(api, "sync");
      return Promise.resolve().then(() => {
        api.registerProvider({ id: "async-provider", label: "Async", auth: [] });
        api.registerCliBackend({ id: "async-cli", config: { command: "async" } });
        api.registerConfigMigration((config) => ({ config, changes: ["async"] }));
        api.registerAutoEnableProbe(() => "async");
        throw new Error("async registration rejected");
      });
    });
    const first = resolvePluginSetupRegistry();
    await Promise.resolve();
    await Promise.resolve();
    const second = resolvePluginSetupRegistry();
    for (const registry of [first, second]) {
      expect(registry.providers.map((entry) => entry.provider.id)).toEqual(["shared-provider"]);
      expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["shared-cli"]);
      expect(registry.configMigrations).toHaveLength(1);
      expect(registry.autoEnableProbes).toHaveLength(1);
    }
  });

  it.each([
    ["provider", "openai"],
    ["provider", "workspace-shadow"],
    ["cliBackend", "openai"],
    ["cliBackend", "workspace-shadow"],
  ] as const)(
    "rejects ambiguous setup %s owners with second plugin %s before executing code",
    (kind, secondPluginId) => {
      manifests(
        ...["bundled", "workspace"].map((origin) =>
          fixture({
            id: origin === "bundled" ? "openai" : secondPluginId,
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
          ? resolvePluginSetupProviderCore({ provider: "openai", env: {} })
          : resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} }),
      ).toBeUndefined();
      expect(mocks.createJiti).not.toHaveBeenCalled();
    },
  );
});
