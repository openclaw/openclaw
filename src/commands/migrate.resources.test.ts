import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import * as config from "../config/config.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  detectSetupMigrationSources,
  listSetupMigrationOptions,
} from "../wizard/setup.migration-import.js";
import { offerPostInstallMigrations } from "../wizard/setup.post-install-migration.js";
import { migrateDefaultCommand, migrateListCommand } from "./migrate.js";
import { withMemoryMigrationProviders } from "./migrate/memory-import.js";

vi.mock("../cli/prompt.js", () => ({ promptYesNo: async () => true }));

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

type Fixture = ReturnType<typeof createMigrationResourceFixture>;
type FixtureOptions = NonNullable<Parameters<typeof createMigrationResourceFixture>[0]> & {
  interactive?: boolean;
  configPath?: boolean;
};

async function withFixture(options: FixtureOptions, run: (fixture: Fixture) => Promise<void>) {
  const fixture = createMigrationResourceFixture(options);
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  if (options.interactive) {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  }
  const state = path.join(fixture.root, "state");
  try {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: state,
        ...(options.configPath ? { OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json") } : {}),
      },
      () => run(fixture),
    );
  } finally {
    if (stdin) {
      Object.defineProperty(process.stdin, "isTTY", stdin);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    fixture.cleanup();
  }
}

function applyOptions(fixture: Fixture) {
  return {
    provider: fixture.id,
    configOverride: fixture.config,
    yes: true,
    json: true,
    noBackup: true,
    force: true,
  };
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
  expect(fixture.state.connections).toHaveLength(1);
  expect(fixture.state.connections[0]?.disposals).toBe(disposals);
  expect(fixture.state.connections[0]?.database.isOpen).toBe(isOpen);
}

describe("migration command resources", () => {
  it.each(["command", "list", "memory"] as const)(
    "refuses %s imports before provider loading when discovery finds a live Gateway",
    async (surface) => {
      await withFixture({}, async (fixture) => {
        fixture.state.resumeApply.resolve();
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
                  yes: true,
                  json: true,
                  noBackup: true,
                  force: true,
                });
        await expect(operation).rejects.toThrow("stop the Gateway");
        expect(discover).toHaveBeenCalled();
        expect(loadConfig).not.toHaveBeenCalled();
        expect(fixture.state).toMatchObject({ connections: [], applyCalls: 0 });
        expect(consume).not.toHaveBeenCalled();
      });
    },
  );

  it.each([false, true])(
    "keeps native plan resources through apply and releases them after completion (failure: %s)",
    async (failApply) => {
      await withFixture({ failApply }, async (fixture) => {
        const logs: string[] = [];
        const command = migrateDefaultCommand(
          {
            exit: createNonExitingRuntime().exit,
            error() {},
            log(value) {
              expect(fixture.state.connections.every(({ database }) => database.isOpen)).toBe(true);
              logs.push(String(value));
            },
          },
          applyOptions(fixture),
        );
        // Early failure must also release a test waiting for the provider rendezvous.
        const completion = settled(command);
        try {
          await Promise.race([fixture.state.applying.promise, completion]);
          const ownerPath = gatewayLock.resolveGatewayLockPaths(process.env).ownerLockPath;
          expect(gatewayLock.readLockPayloadSync(ownerPath)).toMatchObject({
            pid: process.pid,
            role: "agent-embedded",
          });
          expect(fixture.state.applied).toBeDefined();
          expect(fixture.state.applied).toBe(fixture.state.planned);
          expectConnection(fixture, 0, true);
          expect(
            fixture.state.connections[0]?.database.prepare("SELECT 42 AS value").get(),
          ).toEqual({ value: 42 });
          fixture.state.resumeApply.resolve();
          const outcome = await completion;
          if (failApply) {
            expect(outcome.error).toEqual(new Error("Synthetic migration apply failed"));
            expect(logs).toEqual([]);
          } else {
            expect(outcome).toMatchObject({
              error: undefined,
              result: { summary: { migrated: 1 } },
            });
            expect(outcome.result?.metadata).toBe(fixture.state.planned?.metadata);
            expect(outcome.result?.metadata).toEqual({ read: expect.any(Function) });
            expect(logs).toHaveLength(1);
            expect(JSON.parse(logs[0] ?? "{}").summary.migrated).toBe(1);
          }
          expectConnection(fixture, 1, false);
          expect(gatewayLock.readLockPayloadSync(ownerPath)).toBeNull();
        } finally {
          fixture.state.resumeApply.resolve();
          await completion;
        }
      });
    },
  );

  it("borrows an active raw provider without disposing its connection", async () => {
    await withFixture({}, async (fixture) => {
      const active = await loadAndActivateRootPluginRegistry({ config: fixture.config });
      expect(active.migrationProviders.map(({ provider }) => provider.id)).toContain(fixture.id);
      fixture.state.resumeApply.resolve();
      const result = await migrateDefaultCommand(createNonExitingRuntime(), applyOptions(fixture));
      expect(result.summary.migrated).toBe(1);
      expectConnection(fixture, 0, true);
      expect(fixture.state.connections[0]?.database.prepare("SELECT 42 AS value").get()).toEqual({
        value: 42,
      });
    });
  });

  it("keeps post-install plan details alive through config projection and preparation disposal", async () => {
    await withFixture({ configPatch: true, interactive: true }, async (fixture) => {
      fixture.state.resumeApply.resolve();
      const completion = settled(postInstall(fixture));
      try {
        await Promise.race([fixture.state.preparationDisposing.promise, completion]);
        expect(fixture.state.applied).toBe(fixture.state.planned);
        const ownerPath = gatewayLock.resolveGatewayLockPaths(process.env).ownerLockPath;
        expect(gatewayLock.readLockPayloadSync(ownerPath)).toMatchObject({
          pid: process.pid,
          role: "agent-embedded",
        });
        expect(fixture.state.patchReads).toBeGreaterThan(0);
        expectConnection(fixture, 0, true);
        fixture.state.finishPreparation.resolve();
        const outcome = await completion;
        expect(outcome).toMatchObject({
          error: undefined,
          result: { config: { agents: { defaults: { heartbeat: { every: "42m" } } } } },
        });
        expect(fixture.state.preparationDisposals).toBe(1);
        expectConnection(fixture, 1, false);
      } finally {
        fixture.state.finishPreparation.resolve();
        await completion;
      }
    });
  });

  it("logs the primary migration failure before a prepared instance disposal failure aborts onboarding", async () => {
    await withFixture({ failApply: true, interactive: true, configPath: true }, async (fixture) => {
      fixture.state.resumeApply.resolve();
      fixture.state.finishPreparation.resolve();
      fixture.state.failPreparationDisposal = true;
      const messages: string[] = [];
      await expect(
        postInstall(fixture, {
          ...createNonExitingRuntime(),
          log(message) {
            expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
            expect(fixture.state.preparationDisposals).toBe(0);
            messages.push(String(message));
          },
        }),
      ).rejects.toBe(fixture.state.preparationError);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Synthetic migration apply failed");
      expect(fixture.state.preparationDisposals).toBe(1);
      expectConnection(fixture, 1, false);
    });
  });

  it("carries runtime metadata for a negative detection after its native registration closes", async () => {
    await withFixture({ detectFound: false, configPath: true }, async (fixture) => {
      const discovery = await detectSetupMigrationSources({
        config: fixture.config,
        runtime: createNonExitingRuntime(),
      });
      expect(discovery.detections).toEqual([]);
      expect(fixture.state.connections).toHaveLength(1);
      expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
      const params = { baseConfig: fixture.config, ...discovery };
      const options = await listSetupMigrationOptions(params);
      expect(options).toEqual([
        {
          providerId: fixture.id,
          label: "Import from Native migration fixture",
          hint: "Native source 42",
        },
      ]);
      expect(await listSetupMigrationOptions(params)).toEqual(options);
      expectConnection(fixture, 1, false);
    });
  });

  it.each([1, 2])(
    "preserves completed provider config patches when registration %s cleanup fails",
    async (failedConnection) => {
      await withFixture(
        {
          configPatch: true,
          secondProvider: true,
          interactive: true,
          configPath: true,
        },
        async (fixture) => {
          fixture.state.resumeApply.resolve();
          fixture.state.finishPreparation.resolve();
          fixture.state.failCleanupOnConnection = failedConnection;
          const messages: string[] = [];
          const result = await postInstall(fixture, {
            ...createNonExitingRuntime(),
            log: (message) => {
              messages.push(String(message));
            },
          });
          expect(fixture.state).toMatchObject({ applyCalls: 2, preparationDisposals: 2 });
          expect(result.config.agents?.defaults?.heartbeat?.every).toBe("43m");
          expect(fixture.state.preparationOwners).toHaveLength(2);
          for (const owner of fixture.state.preparationOwners) {
            expect(owner.prepared === owner.applied, owner.providerId).toBe(true);
          }
          const cleanupWarnings = messages.filter((message) =>
            message.includes("plugin cleanup failed"),
          );
          expect(cleanupWarnings).toHaveLength(1);
          expect(cleanupWarnings[0]).toContain(
            "migration result retained, but plugin cleanup failed",
          );
          expect(messages.some((message) => message.includes("migration failed:"))).toBe(false);
          expect(messages.some((message) => message.includes("Re-run with"))).toBe(false);
          expect(
            fixture.state.connections.every(
              ({ database, disposals }) => !database.isOpen && disposals === 1,
            ),
          ).toBe(true);
        },
      );
    },
  );
});
