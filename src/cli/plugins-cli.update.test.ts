import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import {
  attachPluginInstallOwnerMigrations,
  resolvePluginInstallTransactionRequest,
  type PluginInstallTransaction,
} from "../plugins/install-transaction.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import {
  createTestInstalledPluginIndex,
  pluginCliConfigMock,
  resolvePluginLifecycleGatewayMock,
  pluginLifecycleGatewayMock,
  readConfigFileSnapshotForWriteMock,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock,
  replaceConfigFileMock,
  resetPluginsCliTestState,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  promptYesNoMock,
  setInstalledPluginIndexInstallRecords,
  setHookInstallRecords,
  updateNpmInstalledHookPacksMock,
  updateNpmInstalledPluginsMock,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";
import {
  expectInstallRecordsWrittenWithLease,
  writtenIndexCustody,
} from "./plugins-cli.update.test-support.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const originalEnv = captureEnv(["OPENCLAW_NIX_MODE"]);
const { set: setTty, restore: restoreTty } = createCliTtyMock();

function createTrackedPluginConfig(params: { pluginId: string; spec: string }): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "npm",
          spec: params.spec,
          installPath: `/tmp/${params.pluginId}`,
        },
      },
    },
  } as OpenClawConfig;
}

function primeTrackedPluginUpdate(
  params: Parameters<typeof createTrackedPluginConfig>[0],
): OpenClawConfig {
  const config = createTrackedPluginConfig(params);
  pluginCliConfigMock.mockReturnValue(config);
  setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
  primePluginUpdate(config);
  return config;
}

function createCapabilityConsentReview(): PluginCapabilityConsentReview {
  return {
    pluginId: "alpha",
    name: "Alpha plugin",
    version: "2.0.0",
    source: { kind: "npm", spec: "@acme/alpha", integrity: "sha512-alpha" },
    declared: {
      channels: [],
      providers: [],
      tools: ["read", "write"],
      contracts: ["gatewayMethodDispatch: alpha.run"],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: true },
        allowConversationAccess: { effective: false },
      },
    },
    widened: { tools: ["write"] },
    trust: { disposition: "review-recommended", reasons: ["Community maintained"] },
    reviewToken: "reviewed-alpha-surface",
  };
}

function expectOfflineNoticeLogged() {
  expect(pluginsCliRuntimeLogs).toContain(
    "Updates saved; they will load on the next Gateway start.",
  );
}

function expectSingleCallParams(mockFn: ReturnType<typeof vi.fn>) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  const params = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (params === undefined) {
    throw new Error("expected call params");
  }
  return params;
}

function primeUpdateConfigSnapshot(params: {
  config: OpenClawConfig;
  loadedConfig?: OpenClawConfig;
  parsed?: Record<string, unknown>;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  valid?: boolean;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
}) {
  const configPath = path.join(process.cwd(), "openclaw.json5");
  const parsed = params.parsed ?? (params.config as Record<string, unknown>);
  const sourceConfig = params.sourceConfig ?? params.config;
  const runtimeConfig = params.runtimeConfig ?? params.config;
  const prepared = {
    snapshot: {
      ...createTestConfigSnapshot(sourceConfig, runtimeConfig, configPath),
      raw: JSON.stringify(parsed),
      parsed,
      valid: params.valid ?? true,
      hash: "update-config",
    },
    writeOptions: {
      assertConfigPathForWrite: () => {},
      expectedConfigPath: configPath,
      ownedConfigPathForWrite: configPath,
      includeFileHashesForWrite: params.includeFileHashesForWrite,
      includeFileTargetsForWrite: params.includeFileTargetsForWrite,
    },
  };
  pluginCliConfigMock.mockReturnValue(params.loadedConfig ?? params.config);
  readConfigFileSnapshotForWriteMock.mockResolvedValue(prepared);
  return prepared;
}

function primeBlockedUpdateConfig(section: "hooks" | "plugins", config: OpenClawConfig): void {
  const externalPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    `${section}.json5`,
  );
  primeUpdateConfigSnapshot({
    config,
    parsed: { [section]: { $include: externalPath } },
    includeFileTargetsForWrite: {
      [externalPath]: externalPath,
    },
  });
}

function primePluginUpdate(
  config: OpenClawConfig,
  outcomes: Awaited<ReturnType<typeof updateNpmInstalledPluginsMock>>["outcomes"] = [],
  changed = false,
  transactions?: PluginInstallTransaction[],
  installOwnerMigrations?: Readonly<Record<string, string>>,
): void {
  updateNpmInstalledPluginsMock.mockImplementation(async (params: unknown) => {
    resolvePluginInstallTransactionRequest(params as object)?.transactionSink?.push(
      ...(transactions ?? []),
    );
    const result = {
      config,
      changed,
      outcomes,
    };
    return installOwnerMigrations
      ? attachPluginInstallOwnerMigrations(result, installOwnerMigrations)
      : result;
  });
}

function primeBravePluginRecordUpdate(config: OpenClawConfig) {
  const previousRecords = {
    brave: {
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.6.11-beta.2",
      installPath: "/tmp/brave-beta",
      resolvedName: "@openclaw/brave-plugin",
      resolvedVersion: "2026.6.11-beta.2",
    },
  } as const;
  const nextRecords = {
    brave: {
      ...previousRecords.brave,
      spec: "@openclaw/brave-plugin@2026.6.11",
      installPath: "/tmp/brave-stable",
      resolvedVersion: "2026.6.11",
    },
  } as const;
  setInstalledPluginIndexInstallRecords(previousRecords);
  primePluginUpdate(
    {
      ...config,
      plugins: {
        ...config.plugins,
        installs: nextRecords,
      },
    } as OpenClawConfig,
    [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
    true,
  );
  return { previousRecords, nextRecords };
}

describe("plugins cli update", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    restoreTty();
    originalEnv.restore();
  });

  it("refuses plugin updates in Nix mode before package-manager work", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow(
      "OPENCLAW_NIX_MODE=1",
    );

    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("previews plugin updates in Nix mode without acquiring a lease or writing state", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    setTty(true);
    const config = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@acme/alpha@1.0.0",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config, [
      {
        pluginId: "alpha",
        status: "updated",
        message: "Would update alpha: 1.0.0 -> 1.1.0.",
      },
    ]);
    const lifecycleLease = await import("../plugins/plugin-lifecycle-lease.js");
    const acquireLease = vi.spyOn(lifecycleLease, "withPluginLifecycleLease");

    try {
      await runPluginsCommand(["plugins", "update", "alpha", "--dry-run"]);

      expect(updateNpmInstalledPluginsMock).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, pluginIds: ["alpha"] }),
      );
      expect(updateNpmInstalledPluginsMock.mock.calls[0]?.[0].onCapabilityConsent).toBeUndefined();
      expect(
        updateNpmInstalledPluginsMock.mock.calls[0]?.[0].onInstallPolicyWarning,
      ).toBeUndefined();
      expect(acquireLease).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      expect(pluginsCliRuntimeLogs).toContain("Would update alpha: 1.0.0 -> 1.1.0.");
    } finally {
      acquireLease.mockRestore();
    }
  });

  it.each([
    ["profile", "missing-plugin", [], "work", undefined, "openclaw --profile work"],
    ["container before profile", "missing-plugin", [], "work", "demo", "openclaw --container demo"],
  ] as const)(
    "rejects untracked update target with %s guidance",
    async (_name, id, args, profile, container, prefix) => {
      await withEnvAsync(
        { OPENCLAW_PROFILE: profile, OPENCLAW_CONTAINER_HINT: container },
        async () => {
          const config = {} as OpenClawConfig;
          primeUpdateConfigSnapshot({ config });
          primePluginUpdate(config, [
            { pluginId: id, status: "skipped", message: `No install record for "${id}".` },
          ]);

          await expect(runPluginsCommand(["plugins", "update", id, ...args])).rejects.toThrow(
            "__exit__:1",
          );

          expect(runtimeErrors.at(-1)).toBe(
            `No tracked plugin or hook pack found for "${id}". Run "${prefix} plugins list" or "${prefix} hooks list" to inspect installed packages.`,
          );
          expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
          expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
          expect(configWriteMock).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each([
    { ids: ["alpha", "--all"], error: "not both" },
    { ids: ["@acme/alpha@beta", "@acme/alpha@1.2.3"], error: 'Conflicting npm specs for "alpha"' },
    {
      ids: ["alpha", "@acme/hooks@beta", "@acme/hooks@1.2.3", "--dry-run"],
      error: 'Conflicting npm specs for "hooks"',
    },
  ])("rejects invalid target sets before any updates: $ids", async ({ ids, error }) => {
    primeUpdateConfigSnapshot({ config: {} });
    setInstalledPluginIndexInstallRecords({
      alpha: { source: "npm", spec: "@acme/alpha", installPath: "/tmp/alpha" },
    });
    setHookInstallRecords({
      hooks: { source: "npm", spec: "@acme/hooks", installPath: "/tmp/hooks" },
    });

    await expect(runPluginsCommand(["plugins", "update", ...ids])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(error);
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("updates distinct plugin and hook targets once from the mutation-start snapshot", async () => {
    const config: OpenClawConfig = { plugins: { entries: { alpha: { enabled: true } } } };
    primeUpdateConfigSnapshot({
      config,
      loadedConfig: { plugins: { entries: { alpha: { enabled: false } } } },
    });
    const records = {
      alpha: { source: "npm", spec: "@acme/alpha", installPath: "/tmp/alpha" },
      beta: { source: "npm", spec: "@acme/beta", installPath: "/tmp/beta" },
    } as const;
    setInstalledPluginIndexInstallRecords(records);
    setHookInstallRecords({
      hooks: { source: "npm", spec: "@acme/hooks", installPath: "/tmp/hooks" },
    });
    const nextRecords = { ...records, alpha: { ...records.alpha, spec: "@acme/alpha@beta" } };
    const nextConfig = { plugins: { ...config.plugins, installs: nextRecords } };
    primePluginUpdate(
      nextConfig,
      [
        { pluginId: "alpha", status: "updated", message: "Updated alpha." },
        { pluginId: "beta", status: "unchanged", message: "Beta is current." },
      ],
      true,
    );
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [{ hookId: "hooks", status: "updated", message: "Updated hooks." }],
    });
    resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
    pluginLifecycleGatewayMock.mockResolvedValue({ runtime: { generation: 7 } });

    await runPluginsCommand([
      "plugins",
      "update",
      "beta",
      "@acme/alpha@beta",
      "alpha",
      "beta",
      "hooks",
      "@acme/hooks@beta",
      "hooks",
    ]);

    expect(expectSingleCallParams(updateNpmInstalledPluginsMock)).toMatchObject({
      pluginIds: ["beta", "alpha"],
      specOverrides: { alpha: "@acme/alpha@beta" },
      dryRun: false,
    });
    expect(expectSingleCallParams(updateNpmInstalledHookPacksMock)).toMatchObject({
      hookIds: ["hooks"],
      specOverrides: { hooks: "@acme/hooks@beta" },
      dryRun: false,
    });
    expect(updateNpmInstalledPluginsMock.mock.calls[0]?.[0].config).toEqual({
      plugins: { ...config.plugins, installs: records },
    });
    expect(pluginLifecycleGatewayMock.mock.calls.map(([method]) => method)).toEqual([
      "plugins.list",
      "plugins.refresh",
    ]);
    expectInstallRecordsWrittenWithLease(nextRecords, config);
    expect(pluginsCliRuntimeLogs).toContain("Applied plugin updates in Gateway generation 7.");
  });

  it.each([{ label: "update all", args: ["--all"] }])(
    "rejects ambiguous package paths for $label",
    async ({ args }) => {
      const sharedPath = "/tmp/openclaw-ambiguous-update-pack";
      const installRecords = {
        "pack/one": {
          source: "npm" as const,
          spec: "@acme/pack",
          installPath: sharedPath,
        },
        "pack/two": {
          source: "npm" as const,
          spec: "@acme/pack",
          installPath: sharedPath,
        },
      };
      const config = {} as OpenClawConfig;
      primeUpdateConfigSnapshot({ config });
      setInstalledPluginIndexInstallRecords(installRecords);

      await expect(runPluginsCommand(["plugins", "update", ...args])).rejects.toThrow("__exit__:1");

      expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    },
  );

  it("updates a tracked hook pack selected by npm package name", async () => {
    const cfg = {} as OpenClawConfig;
    const nextConfig = cfg;

    primeUpdateConfigSnapshot({ config: cfg });
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
        resolvedName: "@acme/demo-hooks",
      },
    });
    primePluginUpdate(cfg);
    const transaction = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
    updateNpmInstalledHookPacksMock.mockImplementation(async (params) => {
      resolvePluginInstallTransactionRequest(params)?.transactionSink?.push(transaction);
      return {
        config: nextConfig,
        changed: true,
        outcomes: [
          {
            hookId: "demo-hooks",
            status: "updated",
            message: 'Updated hook pack "demo-hooks": 1.0.0 -> 1.1.0.',
          },
        ],
      };
    });

    await runPluginsCommand([
      "plugins",
      "update",
      "@acme/demo-hooks",
      "--dangerously-force-unsafe-install",
    ]);

    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacksMock);
    expect(hookUpdateParams.config).toEqual({ ...cfg, plugins: { installs: {} } });
    expect(hookUpdateParams.hookIds).toEqual(["demo-hooks"]);
    expect(hookUpdateParams.specOverrides).toEqual({ "demo-hooks": "@acme/demo-hooks" });
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(configWriteMock).toHaveBeenCalledWith(nextConfig);
    expect(replaceConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig, baseHash: "update-config" }),
    );
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(transaction.commit).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expectOfflineNoticeLogged();
  });

  it("retains the install error when package rollback also fails", async () => {
    primeTrackedPluginUpdate({ pluginId: "alpha", spec: "@acme/alpha@1.0.0" });
    const rollback = vi.fn(async () => {
      throw new Error("backup restore failed");
    });
    const commit = vi.fn(async () => {});
    updateNpmInstalledPluginsMock.mockImplementation(async (params) => {
      resolvePluginInstallTransactionRequest(params)?.transactionSink?.push({ commit, rollback });
      throw new Error("plugin install failed");
    });
    await expect(runPluginsCommand(["plugins", "update", "alpha"])).rejects.toThrow(
      "plugin install failed",
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects invalid config snapshots before updater side effects", async () => {
    const cfg = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.0.0",
    });
    primeUpdateConfigSnapshot({
      config: cfg,
      valid: false,
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});

    await expect(runPluginsCommand(["plugins", "update", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toBe(
      "Cannot update plugins or hooks while the config is invalid.",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("allows index-only legacy id migration when an included plugins section has no references", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    const pluginRecords = createTrackedPluginConfig({
      pluginId: "voice-call",
      spec: "@openclaw/voice-call@1.0.0",
    }).plugins?.installs;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: {
          "@openclaw/voice-call": {
            source: "npm",
            spec: "@openclaw/voice-call@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords ?? {});
    primePluginUpdate(
      nextConfig,
      [
        {
          pluginId: "@openclaw/voice-call",
          status: "updated",
          message: "Updated @openclaw/voice-call.",
        },
      ],
      true,
      undefined,
      { "voice-call": "@openclaw/voice-call" },
    );

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, cfg);
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("refreshes the online owner only after releasing the update lease", async () => {
    const config = {};
    primeUpdateConfigSnapshot({ config });
    primeBravePluginRecordUpdate(config);
    const lifecycle = await import("../plugins/plugin-lifecycle-lease.js");
    const original = lifecycle.withPluginLifecycleLease;
    let held = false;
    const spy = vi
      .spyOn(lifecycle, "withPluginLifecycleLease")
      .mockImplementation(
        async <T>(
          options: Parameters<typeof original>[0],
          run: (
            lease: import("../plugins/plugin-lifecycle-lease.js").PluginLifecycleLeaseContext,
          ) => Promise<T>,
        ) =>
          original(options, async (lease) => {
            const wasHeld = held;
            held = true;
            try {
              return await run(lease);
            } finally {
              held = wasHeld;
            }
          }),
      );
    resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
    pluginLifecycleGatewayMock.mockImplementation(async (...args: unknown[]) => {
      const [method] = args;
      expect(held).toBe(false);
      return method === "plugins.refresh"
        ? {
            runtime: { generation: 7 },
            warnings: ["Previous plugin service could not stop."],
          }
        : {};
    });
    try {
      await runPluginsCommand(["plugins", "update", "brave"]);
      expect(pluginLifecycleGatewayMock.mock.calls.map(([method]) => method)).toEqual([
        "plugins.list",
        "plugins.refresh",
      ]);
      expect(pluginsCliRuntimeLogs).toContainEqual(
        expect.stringContaining("Previous plugin service could not stop."),
      );
      expect(pluginsCliRuntimeLogs).toContain("Applied plugin updates in Gateway generation 7.");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mutate packages when the known Gateway is unreachable", async () => {
    resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
    pluginLifecycleGatewayMock.mockRejectedValue(new Error("owner unreachable"));
    await expect(runPluginsCommand(["plugins", "update", "brave"])).rejects.toThrow(
      "owner unreachable",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("commits a moved managed npm load path with its replacement record", async () => {
    const previousInstallPath = "/tmp/openclaw/npm/projects/brave-v1/node_modules/brave";
    const nextInstallPath = "/tmp/openclaw/npm/projects/brave-v2/node_modules/brave";
    const customPath = "/tmp/custom-plugin";
    const cfg = {
      plugins: {
        load: { paths: [previousInstallPath, customPath] },
      },
    } as OpenClawConfig;
    const previousRecords = {
      brave: {
        source: "npm" as const,
        spec: "@openclaw/brave-plugin@1.0.0",
        installPath: previousInstallPath,
      },
    };
    const nextRecords = {
      brave: {
        ...previousRecords.brave,
        spec: "@openclaw/brave-plugin@2.0.0",
        installPath: nextInstallPath,
      },
    };
    const nextConfig = {
      plugins: {
        load: { paths: [nextInstallPath, customPath] },
        installs: nextRecords,
      },
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({ config: cfg });
    setInstalledPluginIndexInstallRecords(previousRecords);
    primePluginUpdate(
      nextConfig,
      [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
      true,
    );

    await runPluginsCommand(["plugins", "update", "brave"]);

    const expectedConfig = { plugins: { load: { paths: [nextInstallPath, customPath] } } };
    expectInstallRecordsWrittenWithLease(nextRecords, expectedConfig);
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: expectedConfig,
      baseHash: "update-config",
      writeOptions: expect.objectContaining({
        afterWrite: {
          mode: "none",
          reason: "plugin update applies runtime after releasing its lease",
        },
      }),
    });
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: expectedConfig,
      installRecords: nextRecords,
      reason: "source-changed",
      ...writtenIndexCustody(),
    });
  });

  it.each(["config changed", "include changed", "invalid config"])(
    "rolls back records-only updates after %s and retains the cause",
    async (failure) => {
      const cfg: OpenClawConfig =
        failure === "include changed"
          ? { plugins: {} }
          : {
              plugins: { entries: { brave: { enabled: true, config: { oldOption: true } } } },
            };
      const initial = primeUpdateConfigSnapshot({
        config: cfg,
        ...(failure === "include changed"
          ? {
              parsed: { plugins: { $include: "/tmp/plugins.json5" } },
              includeFileHashesForWrite: { "/tmp/plugins.json5": "before" },
              includeFileTargetsForWrite: { "/tmp/plugins.json5": "/tmp/plugins.json5" },
            }
          : {}),
      });
      const changed = structuredClone(initial.snapshot);
      const writeOptions = { ...initial.writeOptions };
      let message: string;
      if (failure === "config changed") {
        changed.hash = "changed-config";
        message = "config changed since last load";
      } else if (failure === "include changed") {
        writeOptions.includeFileHashesForWrite = { "/tmp/plugins.json5": "after" };
        message = "included config changed since last load";
      } else {
        changed.valid = false;
        message = "invalid config for plugin brave";
      }
      readConfigFileSnapshotForWriteMock.mockResolvedValueOnce(initial).mockResolvedValueOnce({
        snapshot: {
          ...changed,
          issues:
            failure === "invalid config"
              ? [{ path: "plugins.entries.brave.config.oldOption", message }]
              : [],
        },
        writeOptions,
      });
      const { previousRecords, nextRecords } = primeBravePluginRecordUpdate(cfg);
      const rollback = vi.fn(async () => {});
      const commit = vi.fn(async () => {});
      primePluginUpdate(
        { ...cfg, plugins: { ...cfg.plugins, installs: nextRecords } },
        [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
        true,
        [{ rollback, commit }],
      );
      const previous = createTestInstalledPluginIndex({
        policyHash: "previous-policy",
        installRecords: previousRecords,
      });
      readPersistedInstalledPluginIndexMock.mockResolvedValue(previous);
      const rollbackFailure = new Error("plugin index rollback failed");
      if (failure === "config changed") {
        restorePersistedInstalledPluginIndexIfCurrentMock.mockRejectedValueOnce(rollbackFailure);
      }
      const error = await runPluginsCommand(["plugins", "update", "brave"]).catch(
        (caught: unknown) => caught,
      );
      expect(String(error)).toContain(message);
      if (failure === "config changed") {
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) {
          throw new Error("expected aggregate rollback failure");
        }
        expect(error.cause).toBe(error.errors[0]);
        expect(error.errors).toEqual([expect.objectContaining({ message }), rollbackFailure]);
      }
      expectInstallRecordsWrittenWithLease(nextRecords, cfg);
      expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledWith(
        previous,
        expect.any(Number),
        expect.objectContaining({ filePath: expect.any(String), lease: expect.anything() }),
      );
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("Updated");
    },
  );

  it.each([
    {
      name: "managed npm load path",
      id: "demo",
      record: { source: "npm", spec: "@acme/demo@1.0.0" },
      loadPath: "/tmp/openclaw/npm/projects/demo-v1/node_modules/demo",
    },
    {
      name: "git child load path",
      id: "@acme/demo",
      record: { source: "git", spec: "https://github.com/acme/demo.git#v1.0.0" },
      loadPath: "/tmp/demo/index.js",
    },
    {
      name: "marketplace migration",
      id: "voice-call",
      record: { source: "marketplace", marketplaceSource: "acme", marketplacePlugin: "voice-call" },
    },
    {
      name: "unresolved plugin references",
      id: "voice-call",
      record: { source: "npm", spec: "@openclaw/voice-call" },
      unresolved: true,
    },
  ] satisfies {
    name: string;
    id: string;
    record: import("../config/types.plugins.js").PluginInstallRecord;
    loadPath?: string;
    unresolved?: boolean;
  }[])(
    "blocks $name beside include-owned plugin config before updating",
    async ({ id, record, loadPath, unresolved }) => {
      const externalPath = path.join(
        path.parse(process.cwd()).root,
        "external-openclaw",
        "plugins.json5",
      );
      const config: OpenClawConfig = {
        plugins: loadPath
          ? { load: { paths: [loadPath] } }
          : unresolved
            ? {}
            : { entries: { [id]: { enabled: true } } },
      };
      primeUpdateConfigSnapshot({
        config,
        parsed: { plugins: { $include: externalPath } },
        ...(unresolved
          ? { sourceConfig: { plugins: { $include: externalPath } } as unknown as OpenClawConfig }
          : {}),
        includeFileTargetsForWrite: { [externalPath]: externalPath },
      });
      setInstalledPluginIndexInstallRecords({
        [id]: {
          ...record,
          installPath: loadPath?.includes("node_modules") ? loadPath : "/tmp/demo",
        },
      });
      await expect(runPluginsCommand(["plugins", "update", id])).rejects.toThrow("__exit__:1");
      expect(runtimeErrors.at(-1)).toContain("external or unresolved top-level $include");
      expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
      expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    },
  );

  it("skips an exact orphan path record during bulk update", async () => {
    const cfg = {
      plugins: {
        installs: {
          linked: {
            source: "path",
            sourcePath: "/tmp/linked",
            installPath: "/tmp/linked",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    primePluginUpdate(cfg, [
      { pluginId: "linked", status: "skipped", message: "Skipping linked." },
    ]);
    const installedIndexModule = await import("../plugins/installed-plugin-index.js");
    const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
      createTestInstalledPluginIndex({
        policyHash: "orphan-path-update",
        installRecords: cfg.plugins?.installs ?? {},
      }),
    );
    try {
      await runPluginsCommand(["plugins", "update", "--all"]);

      expect(runtimeErrors).toEqual([]);
      expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
      expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    } finally {
      indexSpy.mockRestore();
    }
  });

  it("preserves skip behavior for ClawHub records missing package metadata", async () => {
    const cfg = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      demo: {
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: "/tmp/demo",
      },
    });
    primePluginUpdate(cfg, [
      {
        pluginId: "demo",
        status: "skipped",
        message: 'Skipping "demo" (missing ClawHub package metadata).',
      },
    ]);

    await runPluginsCommand(["plugins", "update", "demo"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("exits when update is called without id and without --all", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "update"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Provide plugin or hook-pack ids, or use --all.");
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
  });

  it("reports no tracked plugins or hook packs when update --all has empty install records", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.at(-1)).toBe("No tracked plugins or hook packs to update.");
  });

  it("binds explicit update acceptance to the reviewed capability surface", async () => {
    setTty(false);
    primeTrackedPluginUpdate({ pluginId: "alpha", spec: "@acme/alpha" });

    await runPluginsCommand(["plugins", "update", "alpha", "--accept-capabilities"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.pluginIds).toEqual(["alpha"]);
    expect(updateParams).not.toHaveProperty("acknowledgeCapabilities");
    const consent = updateParams.onCapabilityConsent;
    if (typeof consent !== "function") {
      throw new Error("expected explicit plugin capability consent callback");
    }
    await expect(consent(createCapabilityConsentReview())).resolves.toEqual({
      reviewToken: "reviewed-alpha-surface",
    });
    expect(promptYesNoMock).not.toHaveBeenCalled();
  });

  it("shows widened capabilities and requests consent for interactive plugin updates", async () => {
    setTty(true);
    primeTrackedPluginUpdate({ pluginId: "alpha", spec: "@acme/alpha" });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const consent = expectSingleCallParams(updateNpmInstalledPluginsMock).onCapabilityConsent;
    if (typeof consent !== "function") {
      throw new Error("expected interactive plugin capability consent callback");
    }
    await expect(consent(createCapabilityConsentReview())).resolves.toEqual({
      reviewToken: "reviewed-alpha-surface",
    });

    expect(pluginsCliRuntimeLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Alpha plugin (alpha) @ 2.0.0"),
        expect.stringContaining("Integrity: sha512-alpha"),
        expect.stringContaining("Contracts: gatewayMethodDispatch: alpha.run"),
        expect.stringContaining("New tools: write"),
        expect.stringContaining("Conversation access: denied"),
        expect.stringContaining("Trust: review-recommended"),
      ]),
    );
    expect(promptYesNoMock).toHaveBeenCalledWith('Accept these capabilities and update "alpha"?');
  });

  it("shares invocation-wide install-policy acknowledgement across bulk plugin and hook updates", async () => {
    setTty(false);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
      },
    });
    primePluginUpdate(config);
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "--all", "--acknowledge-install-policy-warning"]);

    const pluginAcknowledgement = expectSingleCallParams(
      updateNpmInstalledPluginsMock,
    ).onInstallPolicyWarning;
    const hookAcknowledgement = expectSingleCallParams(
      updateNpmInstalledHookPacksMock,
    ).onInstallPolicyWarning;
    if (typeof pluginAcknowledgement !== "function") {
      throw new Error("expected plugin install-policy acknowledgement callback");
    }
    expect(hookAcknowledgement).toBe(pluginAcknowledgement);
    await expect(
      pluginAcknowledgement({
        targetName: "openclaw-codex-app-server",
        targetType: "plugin",
        requestMode: "update",
      }),
    ).resolves.toEqual({ status: "approved" });
    await expect(
      pluginAcknowledgement({
        targetName: "demo-hooks",
        targetType: "plugin",
        requestMode: "update",
      }),
    ).resolves.toEqual({ status: "approved" });
  });

  it("keeps durable state when transaction cleanup fails after the write", async () => {
    const cfg = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const previousRecords = {
      alpha: {
        source: "npm" as const,
        spec: "@openclaw/alpha@1.0.0",
      },
    };
    const nextRecords = {
      alpha: {
        source: "npm" as const,
        spec: "@openclaw/alpha@1.1.0",
      },
    };
    const runtimeConfig = {
      ...cfg,
      messages: {
        ackReactionScope: "group-mentions",
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      ...runtimeConfig,
      plugins: {
        ...runtimeConfig.plugins,
        installs: nextRecords,
      },
      messages: runtimeConfig.messages,
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      runtimeConfig,
      includeFileHashesForWrite: {
        "/tmp/plugins.json5": "plugins-start-hash",
      },
    });
    setInstalledPluginIndexInstallRecords(previousRecords);
    const rollback = vi.fn(async () => undefined);
    const failedCommit = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const remainingCommit = vi.fn(async () => undefined);
    primePluginUpdate(
      nextRuntimeConfig,
      [{ pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" }],
      true,
      [
        { commit: failedCommit, rollback },
        { commit: remainingCommit, rollback },
      ],
    );
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextRuntimeConfig,
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.config).toEqual({
      ...runtimeConfig,
      plugins: {
        ...runtimeConfig.plugins,
        installs: previousRecords,
      },
    });
    expect(updateParams.pluginIds).toEqual(["alpha"]);
    expect(updateParams.dryRun).toBe(false);
    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(failedCommit).toHaveBeenCalledOnce();
    expect(remainingCommit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: cfg,
      installRecords: nextRecords,
      reason: "source-changed",
      ...writtenIndexCustody(),
    });
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Plugin update committed");
    expect(pluginsCliRuntimeLogs).toContain("Updated alpha -> 1.1.0");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Run openclaw plugins doctor");
    expectOfflineNoticeLogged();
  });

  it.each([{ ids: ["--all"] }])(
    "persists successful updates before reporting errors ($ids)",
    async ({ ids }) => {
      const records = {
        alpha: { source: "npm" as const, spec: "@openclaw/alpha@1.0.0" },
        beta: { source: "npm" as const, spec: "@openclaw/beta@1.0.0" },
      };
      const cfg = { plugins: { installs: records } };
      const nextConfig = {
        plugins: {
          installs: {
            ...records,
            alpha: { ...records.alpha, spec: "@openclaw/alpha@1.1.0" },
          },
        },
      };
      pluginCliConfigMock.mockReturnValue(cfg);
      setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
      primePluginUpdate(
        nextConfig,
        [
          { pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" },
          {
            pluginId: "beta",
            status: "error",
            message: "Failed to update beta: registry timeout",
            channelFallback: {
              requestedSpec: "@openclaw/beta@beta",
              usedSpec: "@openclaw/beta@latest",
              requestedLabel: "beta",
              usedLabel: "latest",
              reason: "failed",
              message: "Beta channel unavailable; tried latest.",
            },
          },
        ],
        true,
      );
      updateNpmInstalledHookPacksMock.mockResolvedValue({
        outcomes: [],
        changed: false,
        config: nextConfig,
      });

      await expect(runPluginsCommand(["plugins", "update", ...ids])).rejects.toThrow("__exit__:1");

      expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, {});
      expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
        config: {},
        installRecords: nextConfig.plugins?.installs,
        reason: "source-changed",
        ...writtenIndexCustody(),
      });
      expect(runtimeErrors).toContain("Failed to update beta: registry timeout");
      expect(pluginsCliRuntimeLogs).toContain("Updated alpha -> 1.1.0");
      expect(pluginsCliRuntimeLogs).toContain("Beta channel unavailable; tried latest.");
      expect(pluginsCliRuntimeLogs).not.toContain("Failed to update beta: registry timeout");
    },
  );

  it("fails a blocked ClawHub update without persisting replacement state", async () => {
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          demo: {
            source: "clawhub",
            spec: "clawhub:@openclaw/plugin-demo",
            clawhubPackage: "@openclaw/plugin-demo",
          },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    const message = "ClawHub blocked this release; existing plugin unchanged.";
    primePluginUpdate(config, [
      { pluginId: "demo", status: "skipped", code: "clawhub_download_blocked", message },
    ]);
    await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.at(-1)).toContain(message);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
