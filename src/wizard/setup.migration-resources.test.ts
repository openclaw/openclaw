import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSetupMemoryImportStep } from "./setup.memory-import.js";
import { detectSetupMigrationSources } from "./setup.migration-import.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

async function withFixture(
  run: (
    fixture: ReturnType<typeof createMigrationResourceFixture>,
    warning: Mock<RuntimeEnv["error"]>,
  ) => Promise<void>,
  detectFound = true,
) {
  const fixture = createMigrationResourceFixture({ detectFound });
  fixture.state.failCleanupOnConnection = 1;
  const warning = vi.fn<RuntimeEnv["error"]>();
  try {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
      },
      async () => {
        await run(fixture, warning);
        expect(fixture.state.connections[0]?.disposals).toBe(1);
        expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
      },
    );
  } finally {
    fixture.cleanup();
  }
}

describe("optional migration results", () => {
  it("retains a completed memory import outcome when native registration cleanup fails", async () => {
    await withFixture(async (fixture, warning) => {
      fixture.state.resumeApply.resolve();
      const result = await runSetupMemoryImportStep({
        config: fixture.config,
        runtime: { ...createNonExitingRuntime(), error: warning },
        prompter: createWizardPrompter({ confirm: async () => true }),
      });
      expect(result.status).toBe("completed");
      expect(fixture.state.applyCalls).toBe(1);
      expect(result.providers).toEqual([
        { providerId: fixture.id, label: "Native migration fixture", migrated: 1, skipped: 0 },
      ]);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain(
        "Memory import result retained, but plugin cleanup failed",
      );
    });
  });

  it.each([true, false])(
    "retains advisory discovery metadata after native cleanup fails (found: %s)",
    async (found) => {
      await withFixture(async (fixture, warning) => {
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
      }, found);
    },
  );

  it("preserves an authority failure even when native registration cleanup also fails", async () => {
    await withFixture(async (fixture, warning) => {
      const authorityError = new Error("Synthetic memory import authority revoked");
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
    });
  });
});
