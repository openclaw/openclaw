import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPluginDeclaredSurface } from "../../test/helpers/plugin-declared-surface.js";
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
  pluginCliConfigMock as configMock,
  pluginLifecycleGatewayMock,
  readConfigFileSnapshotForWriteMock as readWriteSnapshot,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock as refreshRegistry,
  replaceConfigFileMock,
  resetPluginsCliTestState,
  restorePersistedInstalledPluginIndexIfCurrentMock as restoreIndex,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs as logs,
  promptYesNoMock,
  setInstalledPluginIndexInstallRecords,
  setHookInstallRecords,
  updateNpmInstalledHookPacksMock as updateHooks,
  updateNpmInstalledPluginsMock as updatePlugins,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock as writeInstallRecords,
} from "./plugins-cli-test-helpers.js";
import {
  expectInstallRecordsWrittenWithLease,
  writtenIndexCustody,
} from "./plugins-cli.update.test-support.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const originalEnv = captureEnv(["OPENCLAW_NIX_MODE"]);
const { set: setTty, restore: restoreTty } = createCliTtyMock();

function updated(pluginId: string, message = "Updated " + pluginId + ".") {
  return { pluginId, status: "updated" as const, message };
}

function withRecords(
  config: OpenClawConfig,
  installs: Parameters<typeof setInstalledPluginIndexInstallRecords>[0],
): OpenClawConfig {
  return { ...config, plugins: { ...config.plugins, installs } };
}

function createTrackedPluginConfig(pluginId: string, spec: string): OpenClawConfig {
  return withRecords({}, { [pluginId]: { source: "npm", spec, installPath: `/tmp/${pluginId}` } });
}

function primeTrackedPluginUpdate(pluginId: string, spec: string): OpenClawConfig {
  const config = createTrackedPluginConfig(pluginId, spec);
  configMock.mockReturnValue(config);
  setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
  primePluginUpdate(config);
  return config;
}

function update(...args: string[]) {
  return runPluginsCommand(["plugins", "update", ...args]);
}

function createCapabilityConsentReview(): PluginCapabilityConsentReview {
  return {
    pluginId: "alpha",
    name: "Alpha plugin",
    version: "2.0.0",
    source: { kind: "npm", spec: "@acme/alpha", integrity: "sha512-alpha" },
    declared: createPluginDeclaredSurface({
      tools: ["read", "write"],
      contracts: ["gatewayMethodDispatch: alpha.run"],
    }),
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

const offlineNotice = "Updates saved; they will load on the next Gateway start.";

function expectSingleCallParams<T>(mockFn: { mock: { calls: [T, ...unknown[]][] } }): T {
  expect(mockFn).toHaveBeenCalledTimes(1);
  return mockFn.mock.calls[0]![0];
}

function primeUpdateConfigSnapshot(params: {
  config: OpenClawConfig;
  loadedConfig?: OpenClawConfig;
  parsed?: Record<string, unknown>;
  runtimeConfig?: OpenClawConfig;
  valid?: boolean;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
}) {
  const configPath = path.join(process.cwd(), "openclaw.json5");
  const parsed = params.parsed ?? (params.config as Record<string, unknown>);
  const runtimeConfig = params.runtimeConfig ?? params.config;
  const prepared = {
    snapshot: {
      ...createTestConfigSnapshot(params.config, runtimeConfig, configPath),
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
  configMock.mockReturnValue(params.loadedConfig ?? params.config);
  readWriteSnapshot.mockResolvedValue(prepared);
  return prepared;
}

function primeBlockedPluginConfig(config: OpenClawConfig): void {
  const target = path.join(path.parse(process.cwd()).root, "external-openclaw", "plugins.json5");
  primeUpdateConfigSnapshot({
    config,
    parsed: { plugins: { $include: target } },
    includeFileTargetsForWrite: { [target]: target },
  });
}

function primePluginUpdate(
  config: OpenClawConfig,
  outcomes: Awaited<ReturnType<typeof updatePlugins>>["outcomes"] = [],
  changed = false,
  transactions: PluginInstallTransaction[] = [],
  installOwnerMigrations?: Readonly<Record<string, string>>,
): void {
  updatePlugins.mockImplementation(async (params: unknown) => {
    resolvePluginInstallTransactionRequest(params as object)?.transactionSink?.push(
      ...transactions,
    );
    const result = { config, changed, outcomes };
    return installOwnerMigrations
      ? attachPluginInstallOwnerMigrations(result, installOwnerMigrations)
      : result;
  });
}

function primeBraveRecords() {
  const record = (version: string, installPath: string) => ({
    source: "npm" as const,
    spec: `@openclaw/brave-plugin@${version}`,
    installPath,
    resolvedName: "@openclaw/brave-plugin",
    resolvedVersion: version,
  });
  const previousRecords = { brave: record("2026.6.11-beta.2", "/tmp/brave-beta") };
  const nextRecords = { brave: record("2026.6.11", "/tmp/brave-stable") };
  setInstalledPluginIndexInstallRecords(previousRecords);
  return { previousRecords, nextRecords };
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(resetPluginsCliTestState);

afterEach(() => {
  restoreTty();
  originalEnv.restore();
});

it("refuses plugin updates in Nix mode before package-manager work", async () => {
  process.env.OPENCLAW_NIX_MODE = "1";
  await expect(update("--all")).rejects.toThrow("OPENCLAW_NIX_MODE=1");

  expectNoCalls(updatePlugins, updateHooks, configWriteMock);
});

it("previews plugin updates in Nix mode without acquiring a lease or writing state", async () => {
  process.env.OPENCLAW_NIX_MODE = "1";
  setTty(true);
  const config = primeTrackedPluginUpdate("alpha", "@acme/alpha@1.0.0");
  primePluginUpdate(config, [updated("alpha", "Would update alpha: 1.0.0 -> 1.1.0.")]);
  const lifecycleLease = await import("../plugins/plugin-lifecycle-lease.js");
  const acquireLease = vi.spyOn(lifecycleLease, "withPluginLifecycleLease");

  try {
    await update("alpha", "--dry-run");

    expect(updatePlugins).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, pluginIds: ["alpha"] }),
    );
    expect(updatePlugins.mock.calls[0]?.[0].onCapabilityConsent).toBeUndefined();
    expect(updatePlugins.mock.calls[0]?.[0].onInstallPolicyWarning).toBeUndefined();
    expectNoCalls(
      acquireLease,
      configWriteMock,
      replaceConfigFileMock,
      writeInstallRecords,
      refreshRegistry,
    );
    expect(logs).toContain("Would update alpha: 1.0.0 -> 1.1.0.");
  } finally {
    acquireLease.mockRestore();
  }
});

it.each([
  ["profile", undefined, "openclaw --profile work"],
  ["container before profile", "demo", "openclaw --container demo"],
] as const)(
  "rejects untracked update target with %s guidance",
  async (_name, container, prefix) => {
    const id = "missing-plugin";
    await withEnvAsync(
      { OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: container },
      async () => {
        const config = {} as OpenClawConfig;
        primeUpdateConfigSnapshot({ config });

        await expect(update(id)).rejects.toThrow("__exit__:1");

        expect(runtimeErrors.at(-1)).toBe(
          `No tracked plugin or hook pack found for "${id}". Run "${prefix} plugins list" or "${prefix} hooks list" to inspect installed packages.`,
        );
        expectNoCalls(updatePlugins, updateHooks, configWriteMock);
      },
    );
  },
);

it.each([
  { ids: ["alpha", "--all"], error: "not both" },
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

  await expect(update(...ids)).rejects.toThrow("__exit__:1");

  expect(runtimeErrors.at(-1)).toContain(error);
  expectNoCalls(updatePlugins, updateHooks, writeInstallRecords, replaceConfigFileMock);
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
    [updated("alpha"), { pluginId: "beta", status: "unchanged", message: "Beta is current." }],
    true,
  );
  updateHooks.mockResolvedValue({
    config: nextConfig,
    changed: true,
    outcomes: [{ hookId: "hooks", status: "updated", message: "Updated hooks." }],
  });

  await update("beta", "@acme/alpha@beta", "alpha", "beta", "hooks", "@acme/hooks@beta", "hooks");

  expect(expectSingleCallParams(updatePlugins)).toMatchObject({
    pluginIds: ["beta", "alpha"],
    specOverrides: { alpha: "@acme/alpha@beta" },
    dryRun: false,
  });
  expect(expectSingleCallParams(updateHooks)).toMatchObject({
    hookIds: ["hooks"],
    specOverrides: { hooks: "@acme/hooks@beta" },
    dryRun: false,
  });
  expect(updatePlugins.mock.calls[0]?.[0].config).toEqual({
    plugins: { ...config.plugins, installs: records },
  });
  expect(pluginLifecycleGatewayMock).not.toHaveBeenCalled();
  expectInstallRecordsWrittenWithLease(nextRecords, config);
  expect(logs).toContain("Updates saved; they will load on the next Gateway start.");
});

it("rejects ambiguous package paths for update all", async () => {
  const sharedPath = "/tmp/openclaw-ambiguous-update-pack";
  const installRecords = {
    "pack/one": { source: "npm" as const, spec: "@acme/pack", installPath: sharedPath },
    "pack/two": { source: "npm" as const, spec: "@acme/pack", installPath: sharedPath },
  };
  const config = {} as OpenClawConfig;
  primeUpdateConfigSnapshot({ config });
  setInstalledPluginIndexInstallRecords(installRecords);

  await expect(update("--all")).rejects.toThrow("__exit__:1");

  expectNoCalls(updatePlugins, configWriteMock);
});

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
  const transaction = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
  updateHooks.mockImplementation(async (params) => {
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

  await update("@acme/demo-hooks", "--dangerously-force-unsafe-install");

  const hookUpdateParams = expectSingleCallParams(updateHooks);
  expect(hookUpdateParams.config).toEqual({ ...cfg, plugins: { installs: {} } });
  expect(hookUpdateParams.hookIds).toEqual(["demo-hooks"]);
  expect(hookUpdateParams.specOverrides).toEqual({ "demo-hooks": "@acme/demo-hooks" });
  expect(updatePlugins).not.toHaveBeenCalled();
  expect(configWriteMock).toHaveBeenCalledWith(nextConfig);
  expect(replaceConfigFileMock).toHaveBeenCalledWith(
    expect.objectContaining({ nextConfig, baseHash: "update-config" }),
  );
  expect(refreshRegistry).not.toHaveBeenCalled();
  expect(transaction.commit).toHaveBeenCalledOnce();
  expect(transaction.rollback).not.toHaveBeenCalled();
  expect(logs).toContain(offlineNotice);
});

it("rejects invalid config snapshots before updater side effects", async () => {
  const cfg = createTrackedPluginConfig("alpha", "@openclaw/alpha@1.0.0");
  primeUpdateConfigSnapshot({ config: cfg, valid: false });
  setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});

  await expect(update("alpha")).rejects.toThrow("__exit__:1");

  expect(runtimeErrors.at(-1)).toBe("Cannot update plugins or hooks while the config is invalid.");
  expectNoCalls(updatePlugins, updateHooks, configWriteMock);
});

it("allows index-only legacy id migration when an included plugins section has no references", async () => {
  const cfg = { plugins: {} } as OpenClawConfig;
  const pluginRecords = createTrackedPluginConfig("voice-call", "@openclaw/voice-call@1.0.0")
    .plugins?.installs;
  const nextConfig = withRecords(cfg, {
    "@openclaw/voice-call": { source: "npm", spec: "@openclaw/voice-call@1.1.0" },
  }) as OpenClawConfig;
  primeBlockedPluginConfig(cfg);
  setInstalledPluginIndexInstallRecords(pluginRecords ?? {});
  primePluginUpdate(nextConfig, [updated("@openclaw/voice-call")], true, undefined, {
    "voice-call": "@openclaw/voice-call",
  });

  await update("--all");

  expect(runtimeErrors).toEqual([]);
  expect(updatePlugins).toHaveBeenCalledOnce();
  expect(updateHooks).not.toHaveBeenCalled();
  expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, cfg);
  expect(configWriteMock).not.toHaveBeenCalled();
});

it("commits a moved managed npm load path with its replacement record", async () => {
  const previousInstallPath = "/tmp/openclaw/npm/projects/brave-v1/node_modules/brave";
  const nextInstallPath = "/tmp/openclaw/npm/projects/brave-v2/node_modules/brave";
  const customPath = "/tmp/custom-plugin";
  const cfg = {
    plugins: { load: { paths: [previousInstallPath, customPath] } },
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
    plugins: { load: { paths: [nextInstallPath, customPath] }, installs: nextRecords },
  } as OpenClawConfig;
  primeUpdateConfigSnapshot({ config: cfg });
  setInstalledPluginIndexInstallRecords(previousRecords);
  primePluginUpdate(nextConfig, [updated("brave")], true);

  await update("brave");

  const expectedConfig = { plugins: { load: { paths: [nextInstallPath, customPath] } } };
  expectInstallRecordsWrittenWithLease(nextRecords, expectedConfig);
  expect(replaceConfigFileMock).toHaveBeenCalledWith({
    nextConfig: expectedConfig,
    baseHash: "update-config",
    writeOptions: expect.objectContaining({
      afterWrite: expect.objectContaining({ mode: "none" }),
    }),
  });
  expect(refreshRegistry).toHaveBeenCalledWith({
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
        : { plugins: { entries: { brave: { enabled: true, config: { oldOption: true } } } } };
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
    readWriteSnapshot.mockResolvedValueOnce(initial).mockResolvedValueOnce({
      snapshot: {
        ...changed,
        issues:
          failure === "invalid config"
            ? [{ path: "plugins.entries.brave.config.oldOption", message }]
            : [],
      },
      writeOptions,
    });
    const { previousRecords, nextRecords } = primeBraveRecords();
    const rollback = vi.fn(async () => {});
    const commit = vi.fn(async () => {});
    primePluginUpdate(withRecords(cfg, nextRecords), [updated("brave")], true, [
      { rollback, commit },
    ]);
    const previous = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
    });
    readPersistedInstalledPluginIndexMock.mockResolvedValue(previous);
    const rollbackFailure = new Error("plugin index rollback failed");
    if (failure === "config changed") {
      restoreIndex.mockRejectedValueOnce(rollbackFailure);
    }
    const error = await update("brave").catch((caught: unknown) => caught);
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
    expect(restoreIndex).toHaveBeenCalledWith(
      previous,
      expect.any(Number),
      expect.objectContaining({ filePath: expect.any(String), lease: expect.anything() }),
    );
    expectNoCalls(configWriteMock, replaceConfigFileMock, refreshRegistry);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("Updated");
  },
);

it.each([
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
] satisfies {
  name: string;
  id: string;
  record: import("../config/types.plugins.js").PluginInstallRecord;
  loadPath?: string;
}[])(
  "blocks $name beside include-owned plugin config before updating",
  async ({ id, record, loadPath }) => {
    const config: OpenClawConfig = {
      plugins: loadPath
        ? { load: { paths: [loadPath] } }
        : { entries: { [id]: { enabled: true } } },
    };
    primeBlockedPluginConfig(config);
    setInstalledPluginIndexInstallRecords({
      [id]: {
        ...record,
        installPath: loadPath?.includes("node_modules") ? loadPath : "/tmp/demo",
      },
    });
    await expect(update(id)).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain("external or unresolved top-level $include");
    expectNoCalls(updatePlugins, updateHooks, writeInstallRecords, configWriteMock);
  },
);

it.each(["orphan path", "missing ClawHub metadata"] as const)(
  "skips %s without mutating include-owned config",
  async (kind) => {
    const orphan = kind === "orphan path";
    const id = orphan ? "linked" : "demo";
    const records = {
      [id]: orphan
        ? { source: "path" as const, sourcePath: "/tmp/linked", installPath: "/tmp/linked" }
        : { source: "clawhub" as const, spec: "clawhub:demo", installPath: "/tmp/demo" },
    };
    const cfg = orphan
      ? withRecords({}, records)
      : { plugins: { entries: { demo: { enabled: true } } } };
    primeBlockedPluginConfig(cfg);
    setInstalledPluginIndexInstallRecords(records);
    primePluginUpdate(cfg, [
      {
        pluginId: id,
        status: "skipped",
        message: orphan
          ? "Skipping linked."
          : 'Skipping "demo" (missing ClawHub package metadata).',
      },
    ]);
    const indexSpy = orphan
      ? vi
          .spyOn(await import("../plugins/installed-plugin-index.js"), "loadInstalledPluginIndex")
          .mockReturnValue(
            createTestInstalledPluginIndex({
              policyHash: "orphan-path-update",
              installRecords: records,
            }),
          )
      : undefined;
    try {
      await update(orphan ? "--all" : id);
      expect(runtimeErrors).toEqual([]);
      expect(updatePlugins).toHaveBeenCalledOnce();
      expectNoCalls(updateHooks, configWriteMock);
    } finally {
      indexSpy?.mockRestore();
    }
  },
);

it("exits when update is called without id and without --all", async () => {
  configMock.mockReturnValue({ plugins: { installs: {} } } as OpenClawConfig);

  await expect(update()).rejects.toThrow("__exit__:1");

  expect(runtimeErrors.at(-1)).toContain("Provide plugin or hook-pack ids, or use --all.");
  expect(updatePlugins).not.toHaveBeenCalled();
});

it("reports no tracked plugins or hook packs when update --all has empty install records", async () => {
  configMock.mockReturnValue({ plugins: { installs: {} } } as OpenClawConfig);

  await update("--all");

  expectNoCalls(updatePlugins, updateHooks);
  expect(logs.at(-1)).toBe("No tracked plugins or hook packs to update.");
});

it.each([true, false])(
  "binds update consent to the reviewed surface (explicit=%s)",
  async (explicit) => {
    setTty(!explicit);
    primeTrackedPluginUpdate("alpha", "@acme/alpha");
    await update("alpha", ...(explicit ? ["--accept-capabilities"] : []));
    const params = expectSingleCallParams(updatePlugins);
    const consent = params.onCapabilityConsent;
    if (typeof consent !== "function") {
      throw new Error("expected plugin capability consent callback");
    }
    await expect(consent(createCapabilityConsentReview())).resolves.toEqual({
      reviewToken: "reviewed-alpha-surface",
    });
    if (explicit) {
      expect(params.pluginIds).toEqual(["alpha"]);
      expect(params).not.toHaveProperty("acknowledgeCapabilities");
      expect(promptYesNoMock).not.toHaveBeenCalled();
    } else {
      expect(logs).toEqual(
        expect.arrayContaining(
          [
            "Alpha plugin (alpha) @ 2.0.0",
            "Integrity: sha512-alpha",
            "Contracts: gatewayMethodDispatch: alpha.run",
            "New tools: write",
            "Conversation access: denied",
            "Trust: review-recommended",
          ].map((fragment) => expect.stringContaining(fragment)),
        ),
      );
      expect(promptYesNoMock).toHaveBeenCalledWith('Accept these capabilities and update "alpha"?');
    }
  },
);

it("shares invocation-wide install-policy acknowledgement across bulk plugin and hook updates", async () => {
  setTty(false);
  const config = primeTrackedPluginUpdate("openclaw-codex-app-server", "openclaw-codex-app-server");
  setHookInstallRecords({
    "demo-hooks": {
      source: "npm",
      spec: "@acme/demo-hooks@1.0.0",
      installPath: "/tmp/hooks/demo-hooks",
    },
  });
  updateHooks.mockResolvedValue({ config, changed: false, outcomes: [] });

  await update("--all", "--acknowledge-install-policy-warning");

  const pluginAcknowledgement = expectSingleCallParams(updatePlugins).onInstallPolicyWarning;
  const hookAcknowledgement = expectSingleCallParams(updateHooks).onInstallPolicyWarning;
  if (typeof pluginAcknowledgement !== "function") {
    throw new Error("expected plugin install-policy acknowledgement callback");
  }
  expect(hookAcknowledgement).toBe(pluginAcknowledgement);
  for (const targetName of ["openclaw-codex-app-server", "demo-hooks"]) {
    await expect(
      pluginAcknowledgement({
        targetName,
        targetType: "plugin",
        requestMode: "update",
        reason: "Test install-policy warning",
      }),
    ).resolves.toEqual({ status: "approved" });
  }
});

it("keeps durable state when transaction cleanup fails after the write", async () => {
  const cfg = { plugins: { entries: { alpha: { enabled: true } } } } as OpenClawConfig;
  const previousRecords = { alpha: { source: "npm" as const, spec: "@openclaw/alpha@1.0.0" } };
  const nextRecords = { alpha: { source: "npm" as const, spec: "@openclaw/alpha@1.1.0" } };
  const runtimeConfig = {
    ...cfg,
    messages: { ackReactionScope: "group-mentions" },
  } as OpenClawConfig;
  const nextRuntimeConfig = withRecords(runtimeConfig, nextRecords);
  primeUpdateConfigSnapshot({
    config: cfg,
    runtimeConfig,
    includeFileHashesForWrite: { "/tmp/plugins.json5": "plugins-start-hash" },
  });
  setInstalledPluginIndexInstallRecords(previousRecords);
  const rollback = vi.fn(async () => undefined);
  const failedCommit = vi.fn(async () => {
    throw new Error("cleanup failed");
  });
  const remainingCommit = vi.fn(async () => undefined);
  primePluginUpdate(nextRuntimeConfig, [updated("alpha", "Updated alpha -> 1.1.0")], true, [
    { commit: failedCommit, rollback },
    { commit: remainingCommit, rollback },
  ]);

  await update("alpha");

  const updateParams = expectSingleCallParams(updatePlugins);
  expect(updateParams.config).toEqual(withRecords(runtimeConfig, previousRecords));
  expect(updateParams.pluginIds).toEqual(["alpha"]);
  expect(updateParams.dryRun).toBe(false);
  expectInstallRecordsWrittenWithLease(nextRecords, cfg);
  expectNoCalls(updateHooks, configWriteMock, replaceConfigFileMock);
  expect(failedCommit).toHaveBeenCalledOnce();
  expect(remainingCommit).toHaveBeenCalledOnce();
  expect(rollback).not.toHaveBeenCalled();
  expect(refreshRegistry).toHaveBeenCalledWith({
    config: cfg,
    installRecords: nextRecords,
    reason: "source-changed",
    ...writtenIndexCustody(),
  });
  expect(logs.join("\n")).toContain("Plugin update committed");
  expect(logs).toContain("Updated alpha -> 1.1.0");
  expect(logs.join("\n")).toContain("Run openclaw plugins doctor");
  expect(logs).toContain(offlineNotice);
});

it("persists successful bulk updates before reporting errors", async () => {
  const records = {
    alpha: { source: "npm" as const, spec: "@openclaw/alpha@1.0.0" },
    beta: { source: "npm" as const, spec: "@openclaw/beta@1.0.0" },
  };
  const cfg = { plugins: { installs: records } };
  const nextConfig = {
    plugins: {
      installs: { ...records, alpha: { ...records.alpha, spec: "@openclaw/alpha@1.1.0" } },
    },
  };
  configMock.mockReturnValue(cfg);
  setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
  primePluginUpdate(
    nextConfig,
    [
      updated("alpha", "Updated alpha -> 1.1.0"),
      {
        pluginId: "beta",
        status: "error",
        message: "Failed to update beta: registry timeout",
      },
    ],
    true,
  );

  await expect(update("--all")).rejects.toThrow("__exit__:1");

  expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, {});
  expect(refreshRegistry).toHaveBeenCalledWith({
    config: {},
    installRecords: nextConfig.plugins?.installs,
    reason: "source-changed",
    ...writtenIndexCustody(),
  });
  expect(runtimeErrors).toContain("Failed to update beta: registry timeout");
  expect(logs).toContain("Updated alpha -> 1.1.0");
  expect(logs).not.toContain("Failed to update beta: registry timeout");
});

it("fails a blocked ClawHub update without persisting replacement state", async () => {
  const config = withRecords(
    {},
    {
      demo: {
        source: "clawhub",
        spec: "clawhub:@openclaw/plugin-demo",
        clawhubPackage: "@openclaw/plugin-demo",
      },
    },
  );
  configMock.mockReturnValue(config);
  setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
  const message = "ClawHub blocked this release; existing plugin unchanged.";
  primePluginUpdate(config, [
    { pluginId: "demo", status: "skipped", code: "clawhub_download_blocked", message },
  ]);
  await expect(update("demo")).rejects.toThrow("__exit__:1");
  expect(writeInstallRecords).not.toHaveBeenCalled();
  expect(logs.at(-1)).toContain(message);
});
