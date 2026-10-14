/** Small runtime and orchestration helpers for the doctor E2E harness. */
import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { createDoctorConfigSnapshot } from "./doctor-config-snapshot.test-helpers.js";
import { createTestConfigFileStore } from "./test-runtime-config-helpers.js";

export type DoctorConfigSnapshotFixtureParams = {
  config?: Record<string, unknown>;
  parsed?: Record<string, unknown>;
  valid?: boolean;
  issues?: Array<{ path: string; message: string }>;
  legacyIssues?: Array<{ path: string; message: string }>;
};

export function setDoctorStdinTty(value: boolean | undefined): void {
  try {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  } catch {
    // ignore
  }
}

export function createCommandWithTimeoutResult() {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  } as const;
}

export function createLegacyConfigSnapshot() {
  return {
    path: "/tmp/openclaw.json",
    exists: false,
    raw: null,
    parsed: {},
    valid: true,
    config: {},
    issues: [],
    legacyIssues: [],
  } as const;
}

export function createDoctorServiceMocks() {
  return {
    findLegacyGatewayServices: vi.fn().mockResolvedValue([]),
    uninstallLegacyGatewayServices: vi.fn().mockResolvedValue([]),
    findExtraGatewayServices: vi.fn().mockResolvedValue({ services: [], errors: [] }),
    findSystemGatewayServices: vi.fn().mockResolvedValue([]),
    renderGatewayServiceCleanupHints: vi.fn().mockReturnValue(["cleanup"]),
    auditGatewayServiceConfig: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
    buildGatewayInstallPlan: vi.mocked(
      vi.fn().mockResolvedValue({
        programArguments: ["node", "cli", "gateway", "--port", "18789"],
        workingDirectory: "/tmp",
        environment: {},
      }),
    ),
    resolveGatewayAuthTokenForService: vi.fn().mockResolvedValue({ token: undefined }),
    resolveGatewayProgramArguments: vi.fn().mockResolvedValue({
      programArguments: ["node", "cli", "gateway", "--port", "18789"],
    }),
    serviceInstall: vi.fn().mockResolvedValue(undefined),
    serviceIsLoaded: vi.fn().mockResolvedValue(false),
    serviceStop: vi.fn().mockResolvedValue(undefined),
    serviceRestart: vi.fn().mockResolvedValue(undefined),
    serviceUninstall: vi.fn().mockResolvedValue(undefined),
    serviceReadCommand: vi.fn().mockResolvedValue(null),
    callGateway: vi.fn().mockRejectedValue(new Error("gateway closed")),
  };
}

export function applyMockDoctorConfigSnapshot(
  readConfigFileSnapshot: MockFn,
  params: DoctorConfigSnapshotFixtureParams = {},
): void {
  readConfigFileSnapshot.mockResolvedValue(createDoctorConfigSnapshot(params));
}

export function createDoctorConfigTransform(
  readConfigFileSnapshot: MockFn<typeof import("../config/config.js").readConfigFileSnapshot>,
) {
  const committedConfigFiles = createTestConfigFileStore();
  return async (
    params: Parameters<typeof import("../config/config.js").transformConfigFile>[0],
  ) => {
    const { ConfigMutationConflictError } = await import("../config/config.js");
    const { hashConfigRaw, resolveConfigSnapshotHash } =
      await import("../config/io.read-helpers.js");
    const snapshot = await readConfigFileSnapshot();
    const previousHash = resolveConfigSnapshotHash(snapshot);
    if (params.baseHash !== undefined && params.baseHash !== previousHash) {
      throw new ConfigMutationConflictError("config changed since last load");
    }
    if (
      params.writeOptions?.expectedConfigPath !== undefined &&
      params.writeOptions.expectedConfigPath !== snapshot.path
    ) {
      throw new ConfigMutationConflictError("config path changed since last load");
    }
    params.writeOptions?.assertCurrent?.();
    const transformed = await params.transform(
      params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig,
      { snapshot, previousHash, attempt: 0 },
      {},
    );
    await params.writeOptions?.beforeCommit?.();
    params.writeOptions?.assertCurrent?.();
    const committed = committedConfigFiles.write(transformed.nextConfig, snapshot.path);
    const persistedSnapshot = committed.snapshot;
    persistedSnapshot.raw = JSON.stringify(committed.nextConfig);
    persistedSnapshot.parsed = structuredClone(committed.nextConfig);
    persistedSnapshot.hash = hashConfigRaw(persistedSnapshot.raw);
    readConfigFileSnapshot.mockImplementation(
      async () => committedConfigFiles.read(snapshot.path).snapshot,
    );
    return {
      ...committed,
      snapshot,
      previousHash,
      persistedHash: persistedSnapshot.hash,
      persistedSourceConfig: persistedSnapshot.sourceConfig,
      result: transformed.result,
    };
  };
}

export function createDoctorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

export async function arrangeLegacyStateMigrationFixture(deps: {
  confirm: MockFn;
  createDetection: (params: { hasLegacySessions: boolean; preview: string[] }) => unknown;
  detectLegacyStateMigrations: MockFn;
  mockDoctorConfigSnapshot: () => void;
  runLegacyStateMigrations: MockFn;
}): Promise<{
  doctorCommand: unknown;
  runtime: { log: MockFn; error: MockFn; exit: MockFn };
  detectLegacyStateMigrations: MockFn;
  runLegacyStateMigrations: MockFn;
}> {
  deps.mockDoctorConfigSnapshot();

  const { doctorCommand } = await import("./doctor.js");
  const runtime = createDoctorRuntime();

  deps.detectLegacyStateMigrations.mockClear();
  deps.runLegacyStateMigrations.mockClear();
  deps.detectLegacyStateMigrations.mockResolvedValue(
    deps.createDetection({
      hasLegacySessions: true,
      preview: ["- Legacy sessions detected"],
    }),
  );
  deps.runLegacyStateMigrations.mockResolvedValueOnce({
    changes: ["migrated"],
    warnings: [],
    stepReceipts: [],
  });
  deps.confirm.mockClear();

  return {
    doctorCommand,
    runtime,
    detectLegacyStateMigrations: deps.detectLegacyStateMigrations,
    runLegacyStateMigrations: deps.runLegacyStateMigrations,
  };
}
