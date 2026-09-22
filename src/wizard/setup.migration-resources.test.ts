import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSetupMemoryImportStep } from "./setup.memory-import.js";
import { detectSetupMigrationSources } from "./setup.migration-import.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

describe("optional migration results", () => {
  it.each(["completed", "skipped", "nothing-to-import"] as const)(
    "retains a %s memory import outcome when native registration cleanup fails",
    async (status) => {
      const fixture = createMigrationResourceFixture({
        detectFound: status !== "nothing-to-import",
      });
      fixture.state.failCleanupOnConnection = 1;
      fixture.state.resumeApply.resolve();
      const warning = vi.fn();
      try {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
          },
          async () => {
            const result = await runSetupMemoryImportStep({
              config: fixture.config,
              runtime: { ...createNonExitingRuntime(), error: warning },
              prompter: createWizardPrompter({ confirm: async () => status === "completed" }),
            });
            expect(result.status).toBe(status);
            expect(fixture.state.applyCalls).toBe(status === "completed" ? 1 : 0);
            if (status === "completed") {
              expect(result.providers).toEqual([
                {
                  providerId: fixture.id,
                  label: "Native migration fixture",
                  migrated: 1,
                  skipped: 0,
                },
              ]);
            } else {
              expect(result.providers).toEqual([]);
            }
            expect(warning).toHaveBeenCalledOnce();
            expect(warning.mock.calls[0]?.[0]).toContain(
              "Memory import result retained, but plugin cleanup failed",
            );
            expect(fixture.state.connections[0]?.disposals).toBe(1);
            expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
          },
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([true, false])(
    "retains advisory discovery metadata after native cleanup fails (found: %s)",
    async (found) => {
      const fixture = createMigrationResourceFixture({ detectFound: found });
      fixture.state.failCleanupOnConnection = 1;
      const warning = vi.fn();
      try {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
          },
          async () => {
            const result = await detectSetupMigrationSources({
              config: fixture.config,
              runtime: { ...createNonExitingRuntime(), error: warning },
            });
            expect(result.detections.length).toBe(found ? 1 : 0);
            expect(result.providerDescriptors).toEqual([
              {
                providerId: fixture.id,
                label: "Native migration fixture",
                description: "Native source 42",
              },
            ]);
            expect(warning).toHaveBeenCalledOnce();
            expect(warning.mock.calls[0]?.[0]).toContain(
              "Migration discovery result retained, but plugin cleanup failed",
            );
            expect(fixture.state.applyCalls).toBe(0);
            expect(fixture.state.connections[0]?.disposals).toBe(1);
            expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
          },
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("preserves an authority failure even when native registration cleanup also fails", async () => {
    const fixture = createMigrationResourceFixture();
    fixture.state.failCleanupOnConnection = 1;
    const authorityError = new Error("Synthetic memory import authority revoked");
    const warning = vi.fn();
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          await expect(
            runSetupMemoryImportStep({
              config: fixture.config,
              runtime: { ...createNonExitingRuntime(), error: warning },
              prompter: createWizardPrompter({ confirm: async () => true }),
              beforeApply: async () => {
                throw authorityError;
              },
            }),
          ).rejects.toMatchObject({
            cause: authorityError,
            errors: [authorityError, expect.any(Error)],
          });
          expect(warning).not.toHaveBeenCalled();
          expect(fixture.state.applyCalls).toBe(0);
          expect(fixture.state.connections[0]?.disposals).toBe(1);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
        },
      );
    } finally {
      fixture.cleanup();
    }
  });
});
