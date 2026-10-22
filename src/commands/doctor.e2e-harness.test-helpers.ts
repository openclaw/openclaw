import { vi } from "vitest";
import type { readConfigFileSnapshot, transformConfigFile } from "../config/config.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { createDoctorConfigSnapshot as snapshotFixture } from "./doctor-config-snapshot.test-helpers.js";
import { baseConfigSnapshot, createTestConfigFileStore } from "./test-runtime-config-helpers.js";

export type DoctorConfigSnapshotFixtureParams = NonNullable<Parameters<typeof snapshotFixture>[0]>;

export function setDoctorStdinTty(value: boolean | undefined): void {
  try {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  } catch {
    // ignore
  }
}

export function createCommandWithTimeoutResult(stdout = "") {
  return { stdout, stderr: "", code: 0, signal: null, killed: false } as const;
}

export function createLegacyConfigSnapshot() {
  return { ...structuredClone(baseConfigSnapshot), exists: false, raw: null } as const;
}

export function createDoctorServiceMocks() {
  return {
    findLegacyGatewayServices: vi.fn().mockResolvedValue([]),
    uninstallLegacyGatewayServices: vi.fn().mockResolvedValue([]),
    findExtraGatewayServices: vi.fn().mockResolvedValue({ services: [], errors: [] }),
    findSystemGatewayServices: vi.fn().mockResolvedValue([]),
    renderGatewayServiceCleanupHints: vi.fn().mockReturnValue(["cleanup"]),
    auditGatewayServiceConfig: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
    buildGatewayInstallPlan: vi.fn().mockResolvedValue({
      programArguments: ["node", "cli", "gateway", "--port", "18789"],
      workingDirectory: "/tmp",
      environment: {},
    }),
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
  readConfigFileSnapshot.mockResolvedValue(snapshotFixture(params));
}

export function createDoctorConfigTransform(read: MockFn<typeof readConfigFileSnapshot>) {
  const committedConfigFiles = createTestConfigFileStore();
  return async (params: Parameters<typeof transformConfigFile>[0]) => {
    const { base, baseHash, transform, writeOptions: write } = params;
    const { ConfigMutationConflictError } = await import("../config/config.js");
    const { hashConfigRaw, resolveConfigSnapshotHash } =
      await import("../config/io.read-helpers.js");
    const snapshot = await read();
    const previousHash = resolveConfigSnapshotHash(snapshot);
    if (baseHash !== undefined && baseHash !== previousHash) {
      throw new ConfigMutationConflictError("config changed since last load");
    }
    if (write?.expectedConfigPath !== undefined && write.expectedConfigPath !== snapshot.path) {
      throw new ConfigMutationConflictError("config path changed since last load");
    }
    write?.assertCurrent?.();
    const transformed = await transform(
      base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig,
      { snapshot, previousHash, attempt: 0 },
      {},
    );
    await write?.beforeCommit?.();
    write?.assertCurrent?.();
    const committed = committedConfigFiles.write(transformed.nextConfig, snapshot.path);
    const persisted = committed.snapshot;
    persisted.raw = JSON.stringify(committed.nextConfig);
    persisted.parsed = structuredClone(committed.nextConfig);
    persisted.hash = hashConfigRaw(persisted.raw);
    read.mockImplementation(async () => committedConfigFiles.read(snapshot.path).snapshot);
    return {
      ...committed,
      snapshot,
      previousHash,
      persistedHash: persisted.hash,
      persistedSourceConfig: persisted.sourceConfig,
      result: transformed.result,
    };
  };
}

export function createDoctorRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

export async function arrangeLegacyStateMigrationFixture(deps: {
  confirm: MockFn;
  createDetection: (params: { hasLegacySessions: boolean; preview: string[] }) => unknown;
  detectLegacyStateMigrations: MockFn;
  mockDoctorConfigSnapshot: () => void;
  runLegacyStateMigrations: MockFn;
}) {
  const { confirm, createDetection, detectLegacyStateMigrations, runLegacyStateMigrations } = deps;
  deps.mockDoctorConfigSnapshot();

  const { doctorCommand } = await import("./doctor.js");
  const runtime = createDoctorRuntime();

  detectLegacyStateMigrations.mockClear();
  detectLegacyStateMigrations.mockResolvedValue(
    createDetection({ hasLegacySessions: true, preview: ["- Legacy sessions detected"] }),
  );
  runLegacyStateMigrations.mockClear().mockResolvedValueOnce({
    changes: ["migrated"],
    warnings: [],
    stepReceipts: [],
  });
  confirm.mockClear();

  return {
    doctorCommand,
    runtime,
    detectLegacyStateMigrations,
    runLegacyStateMigrations,
  };
}
