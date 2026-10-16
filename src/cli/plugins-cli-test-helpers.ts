// Shared Vitest mocks and runtime capture helpers for plugin CLI command tests.
import { Command } from "commander";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import { getRuntimeConfig } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install-types.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { recordPluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { invokePluginArtifactInstallMock } from "../plugins/test-helpers/install-fixtures.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createPluginCliConfigIO,
  createPluginCliConfigSnapshot,
} from "./plugins-cli-config.test-support.js";
import type { CliMockOutputRuntime } from "./test-runtime-capture.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type ConfigModule = typeof import("../config/config.js");
type StatusModule = typeof import("../plugins/status.js");
type InstallModule = typeof import("../plugins/install.js");
type EnableModule = typeof import("../plugins/enable.js");
type RegistryModule = typeof import("../plugins/plugin-registry.js");
type SlotsModule = typeof import("../plugins/slots.js");
type BundledSourcesModule = typeof import("../plugins/bundled-sources.js");
type HookInstallModule = typeof import("../hooks/install.js");
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type LoadConfigFn = ConfigModule["loadConfig"];
type ReplaceConfigFileFn = ConfigModule["replaceConfigFile"];
type ReportClawHubPluginInstallTelemetryFn =
  (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"];
type InstallPluginFromMarketplaceFn =
  (typeof import("../plugins/marketplace.js"))["installPluginFromMarketplace"];
type InstallPluginFromGitSpecFn =
  (typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"];
type ListMarketplacePluginsFn =
  (typeof import("../plugins/marketplace.js"))["listMarketplacePlugins"];
type ResolveMarketplaceInstallShortcutFn =
  (typeof import("../plugins/marketplace.js"))["resolveMarketplaceInstallShortcut"];
type UpdateNpmInstalledPluginsFn =
  (typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"];
type UpdateNpmInstalledHookPacksFn =
  (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"];
type ReadPersistedInstalledPluginIndexFn =
  (typeof import("../plugins/installed-plugin-index-store.js"))["readPersistedInstalledPluginIndex"];
type RestorePersistedInstalledPluginIndexIfCurrentFn =
  (typeof import("../plugins/installed-plugin-index-store-write.js"))["restorePersistedInstalledPluginIndexIfCurrent"];
type WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn =
  (typeof import("../plugins/installed-plugin-index-records.js"))["writePersistedInstalledPluginIndexInstallRecordsWithLease"];
type PluginInstallRecordMap = Record<string, PluginInstallRecord>;

export function createEmptyUninstallActions() {
  return {
    entry: false,
    install: false,
    allowlist: false,
    denylist: false,
    loadPath: false,
    memorySlot: false,
    contextEngineSlot: false,
    channelConfig: false,
    directory: false,
  };
}

let mockInstalledPluginIndexInstallRecords: PluginInstallRecordMap = {};
let mockHookInstallRecords: Record<string, HookInstallRecord> = {};
let mockInstalledPluginIndexRevision = 0;
const mockPersistedConfigs = new Map<string, OpenClawConfig>();

export function setPersistedPluginConfig(configPath: string, config: OpenClawConfig): void {
  mockPersistedConfigs.set(configPath, structuredClone(config));
}

export function setHookInstallRecords(records: Record<string, HookInstallRecord>): void {
  mockHookInstallRecords = structuredClone(records);
}

function clonePluginInstallRecords(records: PluginInstallRecordMap): PluginInstallRecordMap {
  // Tests mutate records freely; clone to keep helper state from leaking across assertions.
  return structuredClone(records);
}

export function createTestInstalledPluginIndex(params: {
  policyHash: string;
  installRecords: PluginInstallRecordMap;
  plugins?: InstalledPluginIndex["plugins"];
}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: params.policyHash,
    generatedAtMs: 0,
    refreshReason: "source-changed",
    installRecords: clonePluginInstallRecords(params.installRecords),
    plugins: params.plugins ?? [],
    diagnostics: [],
  };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper preserves mock call and result types.
function invokeMock<TArgs extends unknown[], TResult>(mock: unknown, ...args: TArgs): TResult {
  return (mock as (...args: TArgs) => TResult)(...args);
}

// Resolve lazily: Vitest may evaluate factories before the exported mocks initialize.
function forwardMock<T extends (...args: never[]) => unknown>(getMock: () => unknown) {
  return (...args: Parameters<T>): ReturnType<T> => invokeMock(getMock(), ...args);
}

export const pluginCliConfigMock: Mock<LoadConfigFn> = vi.fn<LoadConfigFn>(
  () => ({}) as OpenClawConfig,
);
export const readConfigFileSnapshotMock: AsyncUnknownMock = vi.fn();
export const readConfigFileSnapshotForWriteMock: AsyncUnknownMock = vi.fn();
export const configWriteMock: AsyncUnknownMock = vi.fn(async () => undefined);
export const replaceConfigFileMock = vi.fn<ReplaceConfigFileFn>();
export const installPluginFromMarketplaceMock: Mock<InstallPluginFromMarketplaceFn> = vi.fn();
export const installPluginFromGitSpecMock: Mock<InstallPluginFromGitSpecFn> = vi.fn();
const listMarketplacePlugins: Mock<ListMarketplacePluginsFn> = vi.fn();
export const resolveMarketplaceInstallShortcutMock: Mock<ResolveMarketplaceInstallShortcutFn> =
  vi.fn();
export const enablePluginInConfigMock: UnknownMock = vi.fn();
export const recordPluginInstallMock: UnknownMock = vi.fn();
const loadInstalledPluginIndexInstallRecords: AsyncUnknownMock = vi.fn(async () =>
  clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
);
export const readPersistedInstalledPluginIndexMock: Mock<ReadPersistedInstalledPluginIndexFn> =
  vi.fn<ReadPersistedInstalledPluginIndexFn>(async () => null);
const writeMockInstalledIndexWithLease: WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn =
  async (records) => {
    const previous = await readPersistedInstalledPluginIndexMock();
    const row = (index: InstalledPluginIndex, revision: number) => ({
      state_key: "plugins.installedIndex",
      value_json: JSON.stringify({ index, revision }),
      updated_at_ms: revision,
    });
    const before = previous ? row(previous, mockInstalledPluginIndexRevision) : null;
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
    mockInstalledPluginIndexRevision += 1;
    return {
      previous,
      revision: mockInstalledPluginIndexRevision,
      mutation: {
        databasePath: resolveOpenClawStateSqlitePath(),
        before,
        after: row(
          createTestInstalledPluginIndex({ policyHash: "test-policy", installRecords: records }),
          mockInstalledPluginIndexRevision,
        ),
      },
    };
  };
export const writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock: Mock<WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn> =
  vi.fn<WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn>(
    writeMockInstalledIndexWithLease,
  );
const restoreMockInstalledIndexIfCurrent: RestorePersistedInstalledPluginIndexIfCurrentFn = async (
  index,
  expectedRevision,
) => {
  if (mockInstalledPluginIndexRevision !== expectedRevision) {
    return false;
  }
  mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
    (index?.installRecords ?? {}) as PluginInstallRecordMap,
  );
  mockInstalledPluginIndexRevision += 1;
  return true;
};
export const restorePersistedInstalledPluginIndexIfCurrentMock: Mock<RestorePersistedInstalledPluginIndexIfCurrentFn> =
  vi.fn<RestorePersistedInstalledPluginIndexIfCurrentFn>(restoreMockInstalledIndexIfCurrent);
export const loadPluginManifestRegistryMock: UnknownMock = vi.fn();
export const loadPluginMetadataSnapshotMock = vi.fn(createPluginsCliMetadataSnapshot);
export const buildPluginSnapshotReportMock: UnknownMock = vi.fn();
export const buildPluginRegistrySnapshotReportMock: UnknownMock = vi.fn();
export const buildPluginInspectReportMock: UnknownMock = vi.fn();
export const buildAllPluginInspectReportsMock: UnknownMock = vi.fn();
export const buildPluginDiagnosticsReportMock: UnknownMock = vi.fn();
export const withPluginDiagnosticsReportForInspectionMock =
  vi.fn<StatusModule["withPluginDiagnosticsReportForInspection"]>();
export const retirePluginDiagnosticsMock = vi.fn<() => void | Promise<void>>();
export const buildPluginCompatibilityNoticesMock: UnknownMock = vi.fn();
export const inspectPluginRegistryMock: AsyncUnknownMock = vi.fn();
export const refreshPluginRegistryMock: AsyncUnknownMock = vi.fn();
export const resolvePluginLifecycleGatewayMock = vi.fn();
export const pluginLifecycleGatewayMock: AsyncUnknownMock = vi.fn();
export const clearPluginRegistryLoadCacheMock: UnknownMock = vi.fn();
export const applyExclusiveSlotSelectionMock: UnknownMock = vi.fn();
export const planPluginUninstallMock =
  vi.fn<(typeof import("../plugins/uninstall.js"))["planPluginUninstall"]>();
export const applyPluginUninstallDirectoryRemovalMock =
  vi.fn<(typeof import("../plugins/uninstall.js"))["applyPluginUninstallDirectoryRemoval"]>();
export const updateNpmInstalledPluginsMock: Mock<UpdateNpmInstalledPluginsFn> = vi.fn();
export const updateNpmInstalledHookPacksMock: Mock<UpdateNpmInstalledHookPacksFn> = vi.fn();
export const promptYesNoMock: AsyncUnknownMock = vi.fn();
const promptText: AsyncUnknownMock = vi.fn();
export class PromptInputClosedError extends Error {
  constructor() {
    super("Prompt input closed before an answer was received.");
    this.name = "PromptInputClosedError";
  }
}
export const installPluginFromNpmSpecMock: AsyncUnknownMock = vi.fn();
export const installPluginFromNpmPackArchiveMock: AsyncUnknownMock = vi.fn();
export const installPluginFromPathMock: AsyncUnknownMock = vi.fn();
export const installPluginFromClawHubMock: AsyncUnknownMock = vi.fn();
export const reportClawHubPluginInstallTelemetryMock: Mock<ReportClawHubPluginInstallTelemetryFn> =
  vi.fn(async () => undefined);
export const findBundledPluginSourceMock: UnknownMock = vi.fn();
export const installHooksFromNpmSpecMock: AsyncUnknownMock = vi.fn();
export const installHooksFromPathMock: AsyncUnknownMock = vi.fn();
export const recordHookInstallMock: UnknownMock = vi.fn();

const { defaultRuntime, pluginsCliRuntimeLogs, runtimeErrors, resetRuntimeCapture } = vi.hoisted(
  () => {
    const runtimeLogsLocal: string[] = [];
    const runtimeErrorsLocal: string[] = [];
    const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
    const normalizeStdout = (value: string) => (value.endsWith("\n") ? value.slice(0, -1) : value);
    const stringifyJson = (value: unknown, space = 2) =>
      JSON.stringify(value, null, space > 0 ? space : undefined);
    const defaultRuntimeLocal = {
      log: vi.fn((...args: unknown[]) => {
        runtimeLogsLocal.push(stringifyArgs(args));
      }),
      error: vi.fn((...args: unknown[]) => {
        runtimeErrorsLocal.push(stringifyArgs(args));
      }),
      writeStdout: vi.fn((value: string) => {
        defaultRuntimeLocal.log(normalizeStdout(value));
      }),
      writeJson: vi.fn((value: unknown, space = 2) => {
        defaultRuntimeLocal.log(stringifyJson(value, space));
      }),
      exit: vi.fn((code: number) => {
        throw new Error(`__exit__:${code} ${runtimeErrorsLocal.join("\n")}`);
      }),
    } as CliMockOutputRuntime;
    return {
      defaultRuntime: defaultRuntimeLocal,
      pluginsCliRuntimeLogs: runtimeLogsLocal,
      runtimeErrors: runtimeErrorsLocal,
      resetRuntimeCapture: () => {
        runtimeLogsLocal.length = 0;
        runtimeErrorsLocal.length = 0;
      },
    };
  },
);

export { runtimeErrors, pluginsCliRuntimeLogs };

export function setInstalledPluginIndexInstallRecords(records: PluginInstallRecordMap): void {
  mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
}

function restoreRuntimeCaptureMocks() {
  defaultRuntime.log.mockReset();
  defaultRuntime.log.mockImplementation((...args: unknown[]) => {
    pluginsCliRuntimeLogs.push(args.map((value) => String(value)).join(" "));
  });

  defaultRuntime.error.mockReset();
  defaultRuntime.error.mockImplementation((...args: unknown[]) => {
    runtimeErrors.push(args.map((value) => String(value)).join(" "));
  });

  defaultRuntime.writeStdout.mockReset();
  defaultRuntime.writeStdout.mockImplementation((value: string) => {
    defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
  });

  defaultRuntime.writeJson.mockReset();
  defaultRuntime.writeJson.mockImplementation((value: unknown, space = 2) => {
    defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
  });

  defaultRuntime.exit.mockReset();
  defaultRuntime.exit.mockImplementation((code: number) => {
    throw new Error(`__exit__:${code} ${runtimeErrors.join("\n")}`);
  });
}

vi.mock("../runtime.js", () => ({
  defaultRuntime,
  writeRuntimeJson: (runtime: CliMockOutputRuntime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: () => resolvePluginLifecycleGatewayMock(),
}));

vi.mock("../config/io.factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.factory.js")>();
  return {
    ...actual,
    createConfigIO: (options: Parameters<typeof actual.createConfigIO>[0]) =>
      createPluginCliConfigIO({
        original: actual.createConfigIO(options),
        configPath: options?.configPath,
        persisted: mockPersistedConfigs,
        getRuntimeConfig,
        readSnapshot: () =>
          invokeMock<
            [],
            ReturnType<ReturnType<typeof actual.createConfigIO>["readConfigFileSnapshot"]>
          >(readConfigFileSnapshotMock),
        readSnapshotForWrite: () =>
          invokeMock<
            [],
            ReturnType<ReturnType<typeof actual.createConfigIO>["readConfigFileSnapshotForWrite"]>
          >(readConfigFileSnapshotForWriteMock),
      }),
  };
});

vi.mock("../config/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.js")>();
  const { createConfigIO } = await import("../config/io.factory.js");
  return {
    ...actual,
    createConfigIO,
    readConfigFileSnapshotForWrite: () => createConfigIO().readConfigFileSnapshotForWrite(),
  };
});

// mock-isolation: Plugin CLI fixtures control config writes and Nix behavior without host state.
vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => {
    if (process.env.OPENCLAW_NIX_MODE === "1") {
      throw new Error(
        [
          "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
          "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
          "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
          "OpenClaw Nix overview: https://docs.openclaw.ai/install/nix",
        ].join("\n"),
      );
    }
  },
  getRuntimeConfig: () => pluginCliConfigMock(),
  loadConfig: () => pluginCliConfigMock(),
  captureRuntimeConfigAsyncReader: () => async () => pluginCliConfigMock(),
  readConfigFileSnapshot: forwardMock<ConfigModule["readConfigFileSnapshot"]>(
    () => readConfigFileSnapshotMock,
  ),
  readConfigFileSnapshotForWrite: forwardMock<ConfigModule["readConfigFileSnapshotForWrite"]>(
    () => readConfigFileSnapshotForWriteMock,
  ),
  writeConfigFile: (config: OpenClawConfig) =>
    invokeMock<[OpenClawConfig], ReturnType<ConfigModule["writeConfigFile"]>>(
      configWriteMock,
      config,
    ),
  replaceConfigFile: (params: Parameters<ReplaceConfigFileFn>[0]) => replaceConfigFileMock(params),
}));

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveIsNixMode: () => false,
    resolveIsConfigReadOnly: () => false,
  };
});

vi.mock("../plugins/marketplace.js", () => ({
  installPluginFromMarketplace: ((params: Parameters<InstallPluginFromMarketplaceFn>[0]) =>
    invokePluginArtifactInstallMock<Awaited<ReturnType<InstallPluginFromMarketplaceFn>>>(
      installPluginFromMarketplaceMock,
      params,
    )) as InstallPluginFromMarketplaceFn,
  listMarketplacePlugins: ((...args: Parameters<ListMarketplacePluginsFn>) =>
    listMarketplacePlugins(...args)) as ListMarketplacePluginsFn,
  resolveMarketplaceInstallShortcut: ((...args: Parameters<ResolveMarketplaceInstallShortcutFn>) =>
    resolveMarketplaceInstallShortcutMock(...args)) as ResolveMarketplaceInstallShortcutFn,
}));

vi.mock("../plugins/enable.js", async (importOriginal) => ({
  prepareConfigForDisabledInstall: (await importOriginal<typeof import("../plugins/enable.js")>())
    .prepareConfigForDisabledInstall,
  enableExplicitlySelectedPluginInConfig: forwardMock<
    EnableModule["enableExplicitlySelectedPluginInConfig"]
  >(() => enablePluginInConfigMock),
  enablePluginInConfig: forwardMock<EnableModule["enablePluginInConfig"]>(
    () => enablePluginInConfigMock,
  ),
}));

vi.mock("../plugins/installs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/installs.js")>();
  return {
    ...actual,
    recordPluginInstall: forwardMock<
      (typeof import("../plugins/installs.js"))["recordPluginInstall"]
    >(() => recordPluginInstallMock),
  };
});

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(loadInstalledPluginIndexInstallRecords, ...args)) as (
      ...args: unknown[]
    ) => unknown,
    writePersistedInstalledPluginIndexInstallRecordsWithLease: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(
        writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
        ...args,
      )) as (...args: unknown[]) => unknown,
    recordPluginInstallInRecords: (
      records: Record<string, unknown>,
      update: { pluginId: string; installedAt?: string } & Record<string, unknown>,
    ) => {
      const { pluginId, ...record } = update;
      return {
        ...records,
        [pluginId]: {
          ...(records[pluginId] as Record<string, unknown> | undefined),
          ...record,
          installedAt: update.installedAt ?? "2026-04-25T00:00:00.000Z",
        },
      };
    },
  };
});

vi.mock("../plugins/installed-plugin-index-record-reader.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-record-reader.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecordsSync: () =>
      clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
  };
});

vi.mock("../plugins/installed-plugin-index-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store.js")>();
  return {
    ...actual,
    readPersistedInstalledPluginIndex: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(readPersistedInstalledPluginIndexMock, ...args)) as (
      ...args: unknown[]
    ) => unknown,
  };
});

vi.mock("../plugins/installed-plugin-index-store-write.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store-write.js")>();
  return {
    ...actual,
    restorePersistedInstalledPluginIndexIfCurrent: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(
        restorePersistedInstalledPluginIndexIfCurrentMock,
        ...args,
      )) as (...args: unknown[]) => unknown,
  };
});

function createPluginsCliMetadataSnapshot(
  params: Parameters<
    (typeof import("../plugins/plugin-metadata-snapshot.js"))["loadPluginMetadataSnapshot"]
  >[0],
) {
  const records = clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords);
  const manifestRegistry = loadPluginManifestRegistryMock({
    ...params,
    installRecords: records,
  }) as import("../plugins/manifest-registry.js").PluginManifestRegistry;
  const snapshot = createPluginMetadataSnapshotFixture(manifestRegistry);
  snapshot.index.installRecords = records;
  snapshot.index.plugins = snapshot.index.plugins.map((plugin) => ({
    ...plugin,
    installOwner: plugin.pluginId,
  }));
  return snapshot;
}

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: Parameters<typeof loadPluginMetadataSnapshotMock>) =>
    loadPluginMetadataSnapshotMock(...args),
  resolvePluginMetadataSnapshot: (...args: Parameters<typeof loadPluginMetadataSnapshotMock>) =>
    loadPluginMetadataSnapshotMock(...args),
}));

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: (
      params: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
    ) =>
      // Artifact reviews inspect the real staged fixture; only installed inventory is mocked.
      params?.discovery
        ? actual.loadPluginManifestRegistryCore(params)
        : invokeMock(loadPluginManifestRegistryMock, params),
  };
});

// mock-isolation: CLI report fixtures own registry leases and cleanup without activating installed plugins.
vi.mock("../plugins/status.js", () => ({
  buildPluginSnapshotReportAsync: async (
    ...args: Parameters<StatusModule["buildPluginSnapshotReport"]>
  ) => buildPluginSnapshotReportMock(...args),
  withPluginDiagnosticsReportForInspection: async (
    ...args: Parameters<typeof withPluginDiagnosticsReportForInspectionMock>
  ) => {
    try {
      return await withPluginDiagnosticsReportForInspectionMock(...args);
    } finally {
      await retirePluginDiagnosticsMock();
    }
  },
  buildPluginSnapshotReport: forwardMock<StatusModule["buildPluginSnapshotReport"]>(
    () => buildPluginSnapshotReportMock,
  ),
  buildPluginRegistrySnapshotReport: forwardMock<StatusModule["buildPluginRegistrySnapshotReport"]>(
    () => buildPluginRegistrySnapshotReportMock,
  ),
  buildPluginInspectReport: forwardMock<StatusModule["buildPluginInspectReport"]>(
    () => buildPluginInspectReportMock,
  ),
  buildAllPluginInspectReports: forwardMock<StatusModule["buildAllPluginInspectReports"]>(
    () => buildAllPluginInspectReportsMock,
  ),
  withPluginDiagnosticsReport: async <T>(
    params: Parameters<StatusModule["withPluginDiagnosticsReport"]>[0],
    consume: (report: import("../plugins/status.js").PluginStatusReport) => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await consume(invokeMock(buildPluginDiagnosticsReportMock, params));
    } finally {
      await retirePluginDiagnosticsMock();
    }
  },
  buildPluginCompatibilityNotices: forwardMock<StatusModule["buildPluginCompatibilityNotices"]>(
    () => buildPluginCompatibilityNoticesMock,
  ),
  formatPluginCompatibilityNotice: (entry: { message: string }) => entry.message,
}));

vi.mock("../plugins/status-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/status-snapshot.js")>();
  return {
    ...actual,
    buildPluginRegistrySnapshotReport: (
      ...args: Parameters<typeof actual.buildPluginRegistrySnapshotReport>
    ) =>
      invokeMock<
        Parameters<typeof actual.buildPluginRegistrySnapshotReport>,
        ReturnType<typeof actual.buildPluginRegistrySnapshotReport>
      >(buildPluginRegistrySnapshotReportMock, ...args),
  };
});

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(loadPluginManifestRegistryMock, ...args)) as (
    ...args: unknown[]
  ) => unknown,
  loadPluginRegistrySnapshotWithMetadata: () => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  }),
  inspectPluginRegistry: forwardMock<RegistryModule["inspectPluginRegistry"]>(
    () => inspectPluginRegistryMock,
  ),
}));

vi.mock("../plugins/plugin-registry-refresh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry-refresh.js")>();
  return {
    ...actual,
    refreshPluginRegistry: forwardMock<
      (typeof import("../plugins/plugin-registry-refresh.js"))["refreshPluginRegistry"]
    >(() => refreshPluginRegistryMock),
  };
});

vi.mock("../plugins/loader.js", () => ({
  clearPluginRegistryLoadCache: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(clearPluginRegistryLoadCacheMock, ...args)) as (
    ...args: unknown[]
  ) => unknown,
}));

vi.mock("../plugins/slots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/slots.js")>();
  return {
    ...actual,
    applyExclusiveSlotSelection: (
      params: Parameters<SlotsModule["applyExclusiveSlotSelection"]>[0],
    ) =>
      invokeMock<[typeof params], ReturnType<SlotsModule["applyExclusiveSlotSelection"]>>(
        applyExclusiveSlotSelectionMock,
        params,
      ),
  };
});

vi.mock("../plugins/uninstall.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/uninstall.js")>();
  return {
    ...actual,
    planPluginUninstall: planPluginUninstallMock,
    applyPluginUninstallDirectoryRemoval: applyPluginUninstallDirectoryRemovalMock,
  };
});

vi.mock("../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/update.js")>();
  return {
    ...actual,
    updateNpmInstalledPlugins: forwardMock<
      (typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]
    >(() => updateNpmInstalledPluginsMock),
  };
});

vi.mock("../hooks/update.js", () => ({
  updateNpmInstalledHookPacks: forwardMock<
    (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]
  >(() => updateNpmInstalledHookPacksMock),
}));

vi.mock("./prompt.js", () => ({
  PromptInputClosedError,
  promptText: forwardMock<(typeof import("./prompt.js"))["promptText"]>(() => promptText),
  promptYesNo: forwardMock<(typeof import("./prompt.js"))["promptYesNo"]>(() => promptYesNoMock),
}));

vi.mock("../plugins/install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE,
  installPluginFromNpmSpec: ((params: Parameters<InstallModule["installPluginFromNpmSpec"]>[0]) =>
    invokePluginArtifactInstallMock<Awaited<ReturnType<InstallModule["installPluginFromNpmSpec"]>>>(
      installPluginFromNpmSpecMock,
      params,
    )) as InstallModule["installPluginFromNpmSpec"],
  installPluginFromNpmPackArchive: ((
    params: Parameters<InstallModule["installPluginFromNpmPackArchive"]>[0],
  ) =>
    invokePluginArtifactInstallMock<
      Awaited<ReturnType<InstallModule["installPluginFromNpmPackArchive"]>>
    >(
      installPluginFromNpmPackArchiveMock,
      params,
    )) as InstallModule["installPluginFromNpmPackArchive"],
  installPluginFromPath: ((params: Parameters<InstallModule["installPluginFromPath"]>[0]) =>
    invokePluginArtifactInstallMock<Awaited<ReturnType<InstallModule["installPluginFromPath"]>>>(
      installPluginFromPathMock,
      params,
    )) as InstallModule["installPluginFromPath"],
}));

vi.mock("../plugins/bundled-sources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-sources.js")>();
  return {
    ...actual,
    findBundledPluginSource: ((
      ...args: Parameters<BundledSourcesModule["findBundledPluginSource"]>
    ) => {
      if (findBundledPluginSourceMock.getMockImplementation()) {
        return invokeMock<
          Parameters<BundledSourcesModule["findBundledPluginSource"]>,
          ReturnType<BundledSourcesModule["findBundledPluginSource"]>
        >(findBundledPluginSourceMock, ...args);
      }
      return actual.findBundledPluginSource(...args);
    }) as BundledSourcesModule["findBundledPluginSource"],
  };
});

vi.mock("../plugins/git-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/git-install.js")>();
  return {
    ...actual,
    installPluginFromGitSpec: ((
      params: Parameters<
        (typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]
      >[0],
    ) =>
      invokePluginArtifactInstallMock<
        Awaited<
          ReturnType<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>
        >
      >(
        installPluginFromGitSpecMock,
        params,
      )) as (typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"],
  };
});

vi.mock("../hooks/install.js", () => ({
  HOOK_INSTALL_ERROR_CODE: {
    MISSING_OPENCLAW_HOOKS: "missing_openclaw_hooks",
    EMPTY_OPENCLAW_HOOKS: "empty_openclaw_hooks",
  },
  installHooksFromNpmSpec: forwardMock<HookInstallModule["installHooksFromNpmSpec"]>(
    () => installHooksFromNpmSpecMock,
  ),
  installHooksFromPath: forwardMock<HookInstallModule["installHooksFromPath"]>(
    () => installHooksFromPathMock,
  ),
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

vi.mock("../hooks/installs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/installs.js")>();
  return {
    ...actual,
    readHookInstalls: () => structuredClone(mockHookInstallRecords),
    recordHookInstall: (...args: Parameters<typeof actual.recordHookInstall>) => {
      recordHookInstallMock(...args);
      return actual.recordHookInstall(...args);
    },
  };
});

vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
  },
  installPluginFromClawHub: ((
    params: Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>[0],
  ) =>
    invokePluginArtifactInstallMock<
      Awaited<ReturnType<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>>
    >(
      installPluginFromClawHubMock,
      params,
    )) as (typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"],
}));

vi.mock("../infra/clawhub-packages.js", () => ({
  reportClawHubPluginInstallTelemetry: forwardMock<
    (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"]
  >(() => reportClawHubPluginInstallTelemetryMock),
}));

const { registerPluginsCli } = await import("./plugins-cli.js");

export async function runPluginsCommand(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerPluginsCli(program);
  return await program.parseAsync(argv, { from: "user" });
}

export function resetPluginsCliTestState() {
  resetRuntimeCapture();
  restoreRuntimeCaptureMocks();
  pluginCliConfigMock.mockReset();
  readConfigFileSnapshotMock.mockReset();
  readConfigFileSnapshotForWriteMock.mockReset();
  configWriteMock.mockReset();
  replaceConfigFileMock.mockReset();
  installPluginFromMarketplaceMock.mockReset();
  listMarketplacePlugins.mockReset();
  resolveMarketplaceInstallShortcutMock.mockReset();
  enablePluginInConfigMock.mockReset();
  recordPluginInstallMock.mockReset();
  mockInstalledPluginIndexInstallRecords = {};
  mockInstalledPluginIndexRevision = 0;
  mockPersistedConfigs.clear();
  loadInstalledPluginIndexInstallRecords.mockReset();
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mockReset();
  readPersistedInstalledPluginIndexMock.mockReset();
  restorePersistedInstalledPluginIndexIfCurrentMock.mockReset();
  loadPluginManifestRegistryMock.mockReset();
  loadPluginMetadataSnapshotMock.mockReset().mockImplementation(createPluginsCliMetadataSnapshot);
  buildPluginSnapshotReportMock.mockReset();
  buildPluginRegistrySnapshotReportMock.mockReset();
  buildPluginInspectReportMock.mockReset();
  buildAllPluginInspectReportsMock.mockReset();
  buildPluginDiagnosticsReportMock.mockReset();
  withPluginDiagnosticsReportForInspectionMock.mockReset();
  withPluginDiagnosticsReportForInspectionMock.mockImplementation(async (_params, formatReport) =>
    formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" }),
  );
  retirePluginDiagnosticsMock.mockReset();
  buildPluginCompatibilityNoticesMock.mockReset();
  inspectPluginRegistryMock.mockReset();
  refreshPluginRegistryMock.mockReset();
  resolvePluginLifecycleGatewayMock.mockReset().mockResolvedValue(null);
  pluginLifecycleGatewayMock
    .mockReset()
    .mockResolvedValue({ runtime: { operationId: "cli-test", generation: 2, pluginIds: [] } });
  clearPluginRegistryLoadCacheMock.mockReset();
  applyExclusiveSlotSelectionMock.mockReset();
  planPluginUninstallMock.mockReset();
  applyPluginUninstallDirectoryRemovalMock.mockReset();
  updateNpmInstalledPluginsMock.mockReset();
  updateNpmInstalledHookPacksMock.mockReset();
  mockHookInstallRecords = {};
  promptText.mockReset();
  promptYesNoMock.mockReset();
  installPluginFromGitSpecMock.mockReset();
  installPluginFromNpmSpecMock.mockReset();
  installPluginFromNpmPackArchiveMock.mockReset();
  installPluginFromPathMock.mockReset();
  installPluginFromClawHubMock.mockReset();
  reportClawHubPluginInstallTelemetryMock.mockReset();
  reportClawHubPluginInstallTelemetryMock.mockResolvedValue(undefined);
  findBundledPluginSourceMock.mockReset();
  installHooksFromNpmSpecMock.mockReset();
  installHooksFromPathMock.mockReset();
  recordHookInstallMock.mockReset();

  pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
  readConfigFileSnapshotMock.mockImplementation(async () =>
    createPluginCliConfigSnapshot(getRuntimeConfig()),
  );
  readConfigFileSnapshotForWriteMock.mockImplementation(async () => {
    const snapshot = (await readConfigFileSnapshotMock()) as { path: string };
    return {
      snapshot,
      writeOptions: {
        assertConfigPathForWrite: () => {},
        expectedConfigPath: snapshot.path,
        ownedConfigPathForWrite: snapshot.path,
      },
    };
  });
  configWriteMock.mockResolvedValue(undefined);
  replaceConfigFileMock.mockImplementation(async (params) => {
    params.writeOptions?.assertConfigPathForWrite?.();
    const nextConfig = params.sourceConfig ?? params.nextConfig;
    await configWriteMock(nextConfig);
    const configPath = params.writeOptions?.ownedConfigPathForWrite ?? "/tmp/openclaw-config.json5";
    setPersistedPluginConfig(configPath, nextConfig);
    return {
      path: configPath,
      previousHash: null,
      snapshot: createTestConfigSnapshot(nextConfig, nextConfig, configPath),
      nextConfig,
      persistedHash: "mock",
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    };
  });
  resolveMarketplaceInstallShortcutMock.mockResolvedValue(null);
  installPluginFromMarketplaceMock.mockResolvedValue({
    ok: false,
    error: "marketplace install failed",
  });
  enablePluginInConfigMock.mockImplementation(((cfg: OpenClawConfig, pluginId: string) => ({
    config: cfg,
    enabled: true,
    pluginId,
  })) as (...args: unknown[]) => unknown);
  recordPluginInstallMock.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
  loadInstalledPluginIndexInstallRecords.mockImplementation(async () =>
    clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
  );
  readPersistedInstalledPluginIndexMock.mockResolvedValue(null);
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mockImplementation(
    writeMockInstalledIndexWithLease,
  );
  restorePersistedInstalledPluginIndexIfCurrentMock.mockImplementation(
    restoreMockInstalledIndexIfCurrent,
  );
  loadPluginManifestRegistryMock.mockImplementation((input: unknown) => {
    const installRecords =
      (input as { installRecords?: PluginInstallRecordMap } | undefined)?.installRecords ?? {};
    return {
      plugins: Object.entries(installRecords).map(([pluginId, record]) => {
        const rootDir = record.installPath ?? record.sourcePath ?? `/tmp/${pluginId}`;
        return recordPluginManifestInstallOwner(
          {
            id: pluginId,
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "global",
            rootDir,
            source: `${rootDir}/index.js`,
            manifestPath: `${rootDir}/openclaw.plugin.json`,
          },
          pluginId,
        );
      }),
      diagnostics: [],
    };
  });
  const defaultPluginReport = {
    plugins: [],
    diagnostics: [],
  };
  buildPluginSnapshotReportMock.mockReturnValue(defaultPluginReport);
  buildPluginRegistrySnapshotReportMock.mockReturnValue({
    ...defaultPluginReport,
    registrySource: "derived",
    registryDiagnostics: [],
  });
  buildPluginDiagnosticsReportMock.mockReturnValue(defaultPluginReport);
  buildPluginCompatibilityNoticesMock.mockReturnValue([]);
  const defaultRegistryIndex = {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    plugins: [],
    diagnostics: [],
  };
  inspectPluginRegistryMock.mockResolvedValue({
    state: "fresh",
    refreshReasons: [],
    differences: [],
    persisted: defaultRegistryIndex,
    current: defaultRegistryIndex,
  });
  refreshPluginRegistryMock.mockResolvedValue(defaultRegistryIndex);
  applyExclusiveSlotSelectionMock.mockImplementation(
    (({ config }: { config: OpenClawConfig }) => config) as (...args: unknown[]) => unknown,
  );
  planPluginUninstallMock.mockImplementation(({ config, pluginId }) => ({
    ok: true,
    config,
    pluginId,
    actions: createEmptyUninstallActions(),
    directoryRemoval: null,
  }));
  applyPluginUninstallDirectoryRemovalMock.mockResolvedValue({
    directoryRemoved: false,
    warnings: [],
  });
  updateNpmInstalledPluginsMock.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  updateNpmInstalledHookPacksMock.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  promptYesNoMock.mockResolvedValue(true);
  promptText.mockResolvedValue("demo");
  installPluginFromPathMock.mockResolvedValue({
    ok: false,
    error: "path install disabled in test",
  });
  installPluginFromGitSpecMock.mockResolvedValue({
    ok: false,
    error: "git install disabled in test",
  });
  installPluginFromNpmSpecMock.mockResolvedValue({
    ok: false,
    error: "npm install disabled in test",
  });
  installPluginFromClawHubMock.mockResolvedValue({
    ok: false,
    error: "clawhub install disabled in test",
  });
  installHooksFromPathMock.mockResolvedValue({
    ok: false,
    error: "hook path install disabled in test",
  });
  installHooksFromNpmSpecMock.mockResolvedValue({
    ok: false,
    error: "hook npm install disabled in test",
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
