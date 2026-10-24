import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import * as config from "../config/config.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime } from "../runtime.js";
import {
  detectSetupMigrationSources,
  listSetupMigrationOptions,
} from "../wizard/setup.migration-import.js";
import { offerPostInstallMigrations } from "../wizard/setup.post-install-migration.js";
import { migrateDefaultCommand, migrateListCommand } from "./migrate.js";
import { withMemoryMigrationProviders } from "./migrate/memory-import.js";

vi.mock("../cli/prompt.js", () => ({ promptYesNo: async () => true }));

type Fixture = ReturnType<typeof createMigrationResourceFixture>;
type FixtureOptions = NonNullable<Parameters<typeof createMigrationResourceFixture>[0]> & {
  interactive?: boolean;
  configPath?: boolean;
};

const fixtures: Fixture[] = [];
const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function createFixture(options: FixtureOptions = {}) {
  const fixture = createMigrationResourceFixture(options);
  fixtures.push(fixture);
  if (options.interactive) {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  }
  const state = path.join(fixture.root, "state");
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  if (options.configPath) {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
  }
  return fixture;
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (stdin) {
    Object.defineProperty(process.stdin, "isTTY", stdin);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  fixtures.splice(0).forEach((fixture) => fixture.cleanup());
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

const applyFlags = { yes: true, json: true, noBackup: true, force: true };
const embeddedOwner = { pid: process.pid, role: "agent-embedded" };
function applyOptions(fixture: Fixture) {
  return { ...applyFlags, provider: fixture.id, configOverride: fixture.config };
}

function postInstall(fixture: Fixture, runtime = createNonExitingRuntime()) {
  return offerPostInstallMigrations({
    config: fixture.config,
    runtime,
    installedPluginIds: [fixture.id],
    prompter: createWizardPrompter({ confirm: async () => true }),
  });
}

function settled<T>(operation: Promise<T>) {
  return operation.then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
}

function expectConnection(fixture: Fixture, disposals: number, isOpen: boolean) {
  expect(fixture.state.connections).toMatchObject([{ disposals, database: { isOpen } }]);
}

it.each(["command", "list", "memory"] as const)(
  "refuses %s imports before provider loading when discovery finds a live Gateway",
  async (surface) => {
    const fixture = createFixture();
    const { state } = fixture;
    state.resumeApply.resolve();
    const loadConfig = vi.spyOn(config, "loadConfig");
    const discover = vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
      pid: process.pid,
      port: 18789,
      ownerId: "synthetic-foreign-gateway",
      createdAt: new Date().toISOString(),
    });
    const consume = vi.fn();
    const operation =
      surface === "memory"
        ? withMemoryMigrationProviders(fixture.config, consume)
        : surface === "list"
          ? migrateListCommand(createNonExitingRuntime(), { json: true })
          : migrateDefaultCommand(createNonExitingRuntime(), {
              provider: fixture.id,
              ...applyFlags,
            });
    await expect(operation).rejects.toThrow("stop the Gateway");
    expect(discover).toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(state).toMatchObject({ connections: [], applyCalls: 0 });
    expect(consume).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "keeps native plan resources through apply and releases them after completion (failure: %s)",
  async (failApply) => {
    const fixture = createFixture({ failApply });
    const { state } = fixture;
    const logs: string[] = [];
    const command = migrateDefaultCommand(
      {
        exit: createNonExitingRuntime().exit,
        error() {},
        log(value) {
          expect(state.connections.every(({ database }) => database.isOpen)).toBe(true);
          logs.push(String(value));
        },
      },
      applyOptions(fixture),
    );
    // Early failure must also release a test waiting for the provider rendezvous.
    const completion = settled(command);
    try {
      await Promise.race([state.applying.promise, completion]);
      const ownerPath = gatewayLock.resolveGatewayLockPaths(process.env).ownerLockPath;
      expect(gatewayLock.readLockPayloadSync(ownerPath)).toMatchObject(embeddedOwner);
      expect(state.applied).toBeDefined();
      expect(state.applied).toBe(state.planned);
      expectConnection(fixture, 0, true);
      expect(state.connections[0]?.database.prepare("SELECT 42 AS value").get()).toEqual({
        value: 42,
      });
      state.resumeApply.resolve();
      const outcome = await completion;
      if (failApply) {
        expect(outcome.error).toEqual(new Error("Synthetic migration apply failed"));
        expect(logs).toEqual([]);
      } else {
        expect(outcome.error).toBeUndefined();
        expect(outcome.result?.summary.migrated).toBe(1);
        expect(outcome.result?.metadata).toBe(state.planned?.metadata);
        expect(outcome.result?.metadata).toEqual({ read: expect.any(Function) });
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0] ?? "{}").summary.migrated).toBe(1);
      }
      expectConnection(fixture, 1, false);
      expect(gatewayLock.readLockPayloadSync(ownerPath)).toBeNull();
    } finally {
      state.resumeApply.resolve();
      await completion;
    }
  },
);

it("borrows an active raw provider without disposing its connection", async () => {
  const fixture = createFixture();
  const { state } = fixture;
  const active = await loadAndActivateRootPluginRegistry({ config: fixture.config });
  expect(active.migrationProviders.map(({ provider }) => provider.id)).toContain(fixture.id);
  state.resumeApply.resolve();
  const result = await migrateDefaultCommand(createNonExitingRuntime(), applyOptions(fixture));
  expect(result.summary.migrated).toBe(1);
  expectConnection(fixture, 0, true);
  expect(state.connections[0]?.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
});

it("keeps post-install plan details alive through config projection and preparation disposal", async () => {
  const fixture = createFixture({ configPatch: true, interactive: true });
  const { state } = fixture;
  state.resumeApply.resolve();
  const completion = settled(postInstall(fixture));
  try {
    await Promise.race([state.preparationDisposing.promise, completion]);
    expect(state.applied).toBe(state.planned);
    const ownerPath = gatewayLock.resolveGatewayLockPaths(process.env).ownerLockPath;
    expect(gatewayLock.readLockPayloadSync(ownerPath)).toMatchObject(embeddedOwner);
    expect(state.patchReads).toBeGreaterThan(0);
    expectConnection(fixture, 0, true);
    state.finishPreparation.resolve();
    const outcome = await completion;
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.config.agents?.defaults?.heartbeat?.every).toBe("42m");
    expect(state.preparationDisposals).toBe(1);
    expectConnection(fixture, 1, false);
  } finally {
    state.finishPreparation.resolve();
    await completion;
  }
});

it("logs the primary migration failure before a prepared instance disposal failure aborts onboarding", async () => {
  const fixture = createFixture({ failApply: true, interactive: true, configPath: true });
  const { state } = fixture;
  state.resumeApply.resolve();
  state.finishPreparation.resolve();
  state.failPreparationDisposal = true;
  const messages: string[] = [];
  await expect(
    postInstall(fixture, {
      ...createNonExitingRuntime(),
      log(message) {
        expect(state.connections[0]?.database.isOpen).toBe(true);
        expect(state.preparationDisposals).toBe(0);
        messages.push(String(message));
      },
    }),
  ).rejects.toBe(state.preparationError);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Synthetic migration apply failed");
  expect(state.preparationDisposals).toBe(1);
  expectConnection(fixture, 1, false);
});

it("carries runtime metadata for a negative detection after its native registration closes", async () => {
  const fixture = createFixture({ detectFound: false, configPath: true });
  const { state } = fixture;
  const discovery = await detectSetupMigrationSources({
    config: fixture.config,
    runtime: createNonExitingRuntime(),
  });
  expect(discovery.detections).toEqual([]);
  expect(state.connections).toHaveLength(1);
  expect(state.connections[0]?.database.isOpen).toBe(false);
  const params = { baseConfig: fixture.config, ...discovery };
  const options = await listSetupMigrationOptions(params);
  const label = "Import from Native migration fixture";
  expect(options).toEqual([{ providerId: fixture.id, label, hint: "Native source 42" }]);
  expect(await listSetupMigrationOptions(params)).toEqual(options);
  expectConnection(fixture, 1, false);
});

it.each([1, 2])(
  "preserves completed provider config patches when registration %s cleanup fails",
  async (failedConnection) => {
    const fixture = createFixture({
      configPatch: true,
      secondProvider: true,
      interactive: true,
      configPath: true,
    });
    const { state } = fixture;
    state.resumeApply.resolve();
    state.finishPreparation.resolve();
    state.failCleanupOnConnection = failedConnection;
    const messages: string[] = [];
    const result = await postInstall(fixture, {
      ...createNonExitingRuntime(),
      log: (message) => {
        messages.push(String(message));
      },
    });
    expect(state).toMatchObject({ applyCalls: 2, preparationDisposals: 2 });
    expect(result.config.agents?.defaults?.heartbeat?.every).toBe("43m");
    expect(state.preparationOwners).toHaveLength(2);
    for (const owner of state.preparationOwners) {
      expect(owner.prepared === owner.applied, owner.providerId).toBe(true);
    }
    const warnings = messages.filter((message) => message.includes("plugin cleanup failed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("migration result retained, but plugin cleanup failed");
    expect(messages.filter((message) => /migration failed:|Re-run with/.test(message))).toEqual([]);
    expect(
      state.connections.every(({ database, disposals }) => !database.isOpen && disposals === 1),
    ).toBe(true);
  },
);
