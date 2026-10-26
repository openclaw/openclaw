import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import { runSetupMemoryImportStep } from "./setup.memory-import.js";
import { detectSetupMigrationSources } from "./setup.migration-import.js";

const fixtures: ReturnType<typeof createMigrationResourceFixture>[] = [];
function createFixture() {
  const fixture = createMigrationResourceFixture();
  fixtures.push(fixture);
  fixture.state.failCleanupOnConnection = 1;
  const stateDir = path.join(fixture.root, "state");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const warning = vi.fn<RuntimeEnv["error"]>();
  const params = {
    config: fixture.config,
    runtime: { ...createNonExitingRuntime(), error: warning },
    prompter: createWizardPrompter({ confirm: async () => true }),
  };
  return { fixture, warning, params };
}

afterEach(() => {
  try {
    for (const fixture of fixtures) {
      expect(fixture.state.connections[0]).toMatchObject({
        disposals: 1,
        database: { isOpen: false },
      });
    }
  } finally {
    fixtures.splice(0).forEach((fixture) => fixture.cleanup());
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
  }
});

it("retains a completed memory import outcome when native registration cleanup fails", async () => {
  const { fixture, warning, params } = createFixture();
  fixture.state.resumeApply.resolve();
  expect(await runSetupMemoryImportStep(params)).toEqual({
    status: "completed",
    providers: [
      { providerId: fixture.id, label: "Native migration fixture", migrated: 1, skipped: 0 },
    ],
  });
  expect(fixture.state.applyCalls).toBe(1);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Memory import result retained, but plugin cleanup failed"),
  );
});

it("retains advisory discovery metadata after native cleanup fails", async () => {
  const { fixture, warning, params } = createFixture();
  const result = await detectSetupMigrationSources(params);
  expect(result.detections).toHaveLength(1);
  expect(result.providerDescriptors).toEqual([
    {
      providerId: fixture.id,
      label: "Native migration fixture",
      description: "Native source 42",
    },
  ]);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Migration discovery result retained, but plugin cleanup failed"),
  );
  expect(fixture.state.applyCalls).toBe(0);
});

it("preserves an authority failure even when native registration cleanup also fails", async () => {
  const { fixture, warning, params } = createFixture();
  const authorityError = new Error("Synthetic memory import authority revoked");
  await expect(
    runSetupMemoryImportStep({
      ...params,
      beforeApply: async () => {
        throw authorityError;
      },
    }),
  ).rejects.toMatchObject({ cause: authorityError, errors: [authorityError, expect.any(Error)] });
  expect(warning).not.toHaveBeenCalled();
  expect(fixture.state.applyCalls).toBe(0);
});
