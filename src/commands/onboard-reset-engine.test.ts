import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  getDatabaseEngineSelection,
  getScopedDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as guided from "./onboard-guided.js";
import * as helpers from "./onboard-helpers.js";
import * as interactive from "./onboard-interactive-runner.js";
import { setupWizardCommand } from "./onboard.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetDatabaseEngineSelectionForTest();
});

it("selects the fresh target only after the reset owner's old-engine cleanup", async () => {
  resetDatabaseEngineSelectionForTest();
  await withOpenClawTestState({ label: "onboard-reset-engine" }, async (state) => {
    await state.writeConfig({
      database: {
        engine: "postgres",
        postgres: {
          connection: "postgresql://127.0.0.1:1/synthetic",
          schemaPrefix: "reset_source",
        },
      },
      plugins: { enabled: false },
    });
    vi.spyOn(interactive, "hasInteractiveOnboardingTty").mockReturnValue(true);
    // Exercise the real owner without performing any Trash operation.
    const cleanup = vi.spyOn(helpers, "handleReset").mockImplementation(async () => {
      expect(getScopedDatabaseEngineSelection()?.effectiveEngines.state).toBe("postgres");
      await fs.unlink(state.configPath);
    });
    const setup = vi.spyOn(guided, "runGuidedOnboarding").mockImplementation(async () => {
      expect(getScopedDatabaseEngineSelection()).toBeUndefined();
      expect(getDatabaseEngineSelection()?.effectiveEngines.state).toBe("sqlite");
    });
    await setupWizardCommand({ reset: true, resetScope: "config" }, createTestRuntime());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
  });
});
