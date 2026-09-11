import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
import { migrateDefaultCommand } from "./migrate.js";

vi.mock("../cli/prompt.js", () => ({ promptYesNo: async () => true }));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

describe("migration command resources", () => {
  it.each([false, true])(
    "keeps native plan resources through apply and releases them after completion (failure: %s)",
    async (failApply) => {
      const fixture = createMigrationResourceFixture({ failApply });
      const logs: string[] = [];
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture.root, "state") }, async () => {
        const command = migrateDefaultCommand(
          {
            exit: createNonExitingRuntime().exit,
            error() {},
            log(value) {
              expect(fixture.state.connections.every(({ database }) => database.isOpen)).toBe(true);
              logs.push(String(value));
            },
          },
          {
            provider: fixture.id,
            configOverride: fixture.config,
            yes: true,
            json: true,
            noBackup: true,
            force: true,
          },
        );
        // Observe early command failure as well as the provider rendezvous, so a
        // loading regression cannot strand the test behind an unfulfilled gate.
        const completion = command.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        try {
          await Promise.race([fixture.state.applying.promise, completion]);
          expect(fixture.state.applied).toBeDefined();
          expect(fixture.state.applied).toBe(fixture.state.planned);
          expect(fixture.state.connections).toHaveLength(1);
          expect(
            fixture.state.connections[0]?.database.prepare("SELECT 42 AS value").get(),
          ).toEqual({ value: 42 });
          expect(fixture.state.connections[0]?.disposals).toBe(0);
          fixture.state.resumeApply.resolve();
          const outcome = await completion;
          if (failApply) {
            expect(outcome.error).toEqual(new Error("Synthetic migration apply failed"));
            expect(logs).toEqual([]);
          } else {
            expect(outcome.error).toBeUndefined();
            expect(outcome.result?.summary.migrated).toBe(1);
            expect(outcome.result?.metadata).toBe(fixture.state.planned?.metadata);
            expect(logs).toHaveLength(1);
            expect(JSON.parse(logs[0] ?? "{}").summary.migrated).toBe(1);
          }
          expect(fixture.state.connections[0]?.disposals).toBe(1);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
        } finally {
          fixture.state.resumeApply.resolve();
          await completion;
          fixture.cleanup();
        }
      });
    },
  );

  it("borrows an active raw provider without disposing its connection", async () => {
    const fixture = createMigrationResourceFixture();
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture.root, "state") }, async () => {
        const active = loadAndActivateRootPluginRegistry({ config: fixture.config });
        expect(active.migrationProviders.map(({ provider }) => provider.id)).toContain(fixture.id);
        fixture.state.resumeApply.resolve();
        const result = await migrateDefaultCommand(createNonExitingRuntime(), {
          provider: fixture.id,
          configOverride: fixture.config,
          yes: true,
          json: true,
          noBackup: true,
          force: true,
        });
        expect(result.summary.migrated).toBe(1);
        expect(fixture.state.connections).toHaveLength(1);
        expect(fixture.state.connections[0]?.disposals).toBe(0);
        expect(fixture.state.connections[0]?.database.prepare("SELECT 42 AS value").get()).toEqual({
          value: 42,
        });
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps post-install plan details alive through config projection and preparation disposal", async () => {
    const fixture = createMigrationResourceFixture({ configPatch: true });
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    fixture.state.resumeApply.resolve();
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture.root, "state") }, async () => {
        const operation = offerPostInstallMigrations({
          config: fixture.config,
          runtime: createNonExitingRuntime(),
          installedPluginIds: [fixture.id],
          prompter: createWizardPrompter({ confirm: async () => true }),
        });
        const completion = operation.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        try {
          await Promise.race([fixture.state.preparationDisposing.promise, completion]);
          expect(fixture.state.applied).toBe(fixture.state.planned);
          expect(fixture.state.patchReads).toBeGreaterThan(0);
          expect(fixture.state.connections).toHaveLength(1);
          expect(fixture.state.connections[0]?.disposals).toBe(0);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
          fixture.state.finishPreparation.resolve();
          const outcome = await completion;
          expect(outcome.error).toBeUndefined();
          expect(outcome.result?.config.agents?.defaults?.heartbeat?.every).toBe("42m");
          expect(fixture.state.preparationDisposals).toBe(1);
          expect(fixture.state.connections[0]?.disposals).toBe(1);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
        } finally {
          fixture.state.finishPreparation.resolve();
          await completion;
        }
      });
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      fixture.cleanup();
    }
  });

  it("prepares and disposes the selected registration after an earlier provider refreshes config", async () => {
    const fixture = createMigrationResourceFixture({ configPatch: true, secondProvider: true });
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    fixture.state.resumeApply.resolve();
    fixture.state.finishPreparation.resolve();
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          const result = await offerPostInstallMigrations({
            config: fixture.config,
            runtime: createNonExitingRuntime(),
            installedPluginIds: [fixture.id],
            prompter: createWizardPrompter({ confirm: async () => true }),
          });
          expect(result.config.agents?.defaults?.heartbeat?.every).toBe("43m");
          expect(fixture.state.preparationOwners).toHaveLength(2);
          for (const owner of fixture.state.preparationOwners) {
            expect(owner.prepared === owner.applied, owner.providerId).toBe(true);
          }
          expect(fixture.state.preparationDisposals).toBe(2);
          expect(fixture.state.connections).toHaveLength(2);
          expect(
            fixture.state.connections.every(
              ({ database, disposals }) => !database.isOpen && disposals === 1,
            ),
          ).toBe(true);
        },
      );
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      fixture.cleanup();
    }
  });

  it("logs the primary migration failure before a prepared instance disposal failure aborts onboarding", async () => {
    const fixture = createMigrationResourceFixture({ failApply: true });
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    fixture.state.resumeApply.resolve();
    fixture.state.finishPreparation.resolve();
    fixture.state.failPreparationDisposal = true;
    const messages: string[] = [];
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          await expect(
            offerPostInstallMigrations({
              config: fixture.config,
              runtime: {
                ...createNonExitingRuntime(),
                log(message) {
                  expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
                  expect(fixture.state.preparationDisposals).toBe(0);
                  messages.push(String(message));
                },
              },
              installedPluginIds: [fixture.id],
              prompter: createWizardPrompter({ confirm: async () => true }),
            }),
          ).rejects.toBe(fixture.state.preparationError);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toContain("Synthetic migration apply failed");
          expect(fixture.state.preparationDisposals).toBe(1);
          expect(fixture.state.connections[0]?.disposals).toBe(1);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
        },
      );
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      fixture.cleanup();
    }
  });

  it("lists cold migration options without executing a full registration", async () => {
    const fixture = createMigrationResourceFixture();
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          const options = await listSetupMigrationOptions({
            baseConfig: fixture.config,
            detections: [],
          });
          expect(options.map((option) => option.providerId)).toContain(fixture.id);
          expect(fixture.state.connections.length).toBe(0);
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("carries runtime metadata for a negative detection after its native registration closes", async () => {
    const fixture = createMigrationResourceFixture({ detectFound: false });
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          const discovery = await detectSetupMigrationSources({
            config: fixture.config,
            runtime: createNonExitingRuntime(),
          });
          expect(discovery.detections).toEqual([]);
          expect(fixture.state.connections.length).toBe(1);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
          const options = await listSetupMigrationOptions({
            baseConfig: fixture.config,
            ...discovery,
          });
          expect(options).toEqual([
            {
              providerId: fixture.id,
              label: "Import from Native migration fixture",
              hint: "Native source 42",
            },
          ]);
          expect(
            await listSetupMigrationOptions({ baseConfig: fixture.config, ...discovery }),
          ).toEqual(options);
          expect(fixture.state.connections.length).toBe(1);
          expect(fixture.state.connections[0]?.disposals).toBe(1);
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([1, 2])(
    "preserves completed provider config patches when registration %s cleanup fails",
    async (failedConnection) => {
      const fixture = createMigrationResourceFixture({ configPatch: true, secondProvider: true });
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      fixture.state.resumeApply.resolve();
      fixture.state.finishPreparation.resolve();
      fixture.state.failCleanupOnConnection = failedConnection;
      const messages: string[] = [];
      try {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
          },
          async () => {
            const result = await offerPostInstallMigrations({
              config: fixture.config,
              runtime: {
                ...createNonExitingRuntime(),
                log: (message) => {
                  messages.push(String(message));
                },
              },
              installedPluginIds: [fixture.id],
              prompter: createWizardPrompter({ confirm: async () => true }),
            });
            expect(fixture.state.applyCalls).toBe(2);
            expect(result.config.agents?.defaults?.heartbeat?.every).toBe("43m");
            const cleanupWarnings = messages.filter((message) =>
              message.includes("plugin cleanup failed"),
            );
            expect(cleanupWarnings).toHaveLength(1);
            expect(cleanupWarnings[0]).toContain(
              "migration result retained, but plugin cleanup failed",
            );
            expect(messages.some((message) => message.includes("migration failed:"))).toBe(false);
            expect(messages.some((message) => message.includes("Re-run with"))).toBe(false);
            expect(fixture.state.preparationDisposals).toBe(2);
            expect(
              fixture.state.connections.every(
                ({ database, disposals }) => !database.isOpen && disposals === 1,
              ),
            ).toBe(true);
          },
        );
      } finally {
        if (stdinDescriptor) {
          Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
        } else {
          Reflect.deleteProperty(process.stdin, "isTTY");
        }
        fixture.cleanup();
      }
    },
  );

  it("retains the normal no-candidates result when outer registration cleanup fails", async () => {
    const fixture = createMigrationResourceFixture({ detectFound: false });
    fixture.state.failCleanupOnConnection = 1;
    const messages: string[] = [];
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          const result = await offerPostInstallMigrations({
            config: fixture.config,
            runtime: {
              ...createNonExitingRuntime(),
              log: (message) => {
                messages.push(String(message));
              },
            },
            installedPluginIds: [fixture.id],
            nonInteractive: true,
          });
          expect(result.config).toBe(fixture.config);
          expect(fixture.state.applyCalls).toBe(0);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toContain("migration result retained, but plugin cleanup failed");
          expect(fixture.state.connections[0]?.disposals).toBe(1);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
        },
      );
    } finally {
      fixture.cleanup();
    }
  });
});
