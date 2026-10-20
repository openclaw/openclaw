import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  getDatabaseEngineSelection,
  getScopedDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { beginLocalOnboarding } from "../state/local-onboarding-state.js";
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

it.each(["config+creds+sessions", "config"] as const)(
  "selects SQLite after %s cleanup",
  async (scope) => {
    resetDatabaseEngineSelectionForTest();
    await withOpenClawTestState(
      { label: "onboard-reset-engine", env: { OPENCLAW_TEST_RESET_DSN_UNAVAILABLE: undefined } },
      async (state) => {
        await state.writeConfig({
          database: {
            engine: "sqlite",
            postgres: {
              connection:
                scope === "config"
                  ? {
                      source: "env",
                      provider: "default",
                      id: "OPENCLAW_TEST_RESET_DSN_UNAVAILABLE",
                    }
                  : "postgresql://127.0.0.1:1/synthetic",
              schemaPrefix: "reset_source",
            },
          },
          plugins: { enabled: false },
        });
        vi.spyOn(interactive, "hasInteractiveOnboardingTty").mockReturnValue(true);
        // Exercise the real owner without performing any Trash operation.
        const cleanup = vi.spyOn(helpers, "handleReset").mockImplementation(async () => {
          expect(getScopedDatabaseEngineSelection()).toBeUndefined();
          await fs.unlink(state.configPath);
        });
        const setup = vi.spyOn(guided, "runGuidedOnboarding").mockImplementation(async () => {
          expect(getScopedDatabaseEngineSelection()).toBeUndefined();
          expect(getDatabaseEngineSelection()?.effectiveEngines.state).toBe("sqlite");
        });
        await setupWizardCommand({ reset: true, resetScope: scope }, createTestRuntime());
        expect(cleanup).toHaveBeenCalledOnce();
        expect(setup).toHaveBeenCalledOnce();
      },
    );
  },
);

it.each(["config+creds+sessions", "full", "config"] as const)(
  "refuses unreadable source state before a %s reset",
  async (scope) => {
    resetDatabaseEngineSelectionForTest();
    await withOpenClawTestState({ label: "onboard-reset-unreadable" }, async (state) => {
      const malformed = '{ database: { engine: "postgres",';
      await fs.writeFile(state.configPath, malformed);
      vi.spyOn(interactive, "hasInteractiveOnboardingTty").mockReturnValue(true);
      const cleanup = vi.spyOn(helpers, "handleReset").mockImplementation(async () => {
        await fs.unlink(state.configPath);
      });
      const setup = vi.spyOn(guided, "runGuidedOnboarding").mockResolvedValue(undefined);
      const runtime = createTestRuntime();
      await setupWizardCommand({ reset: true, resetScope: scope }, runtime);
      expect(cleanup).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Cannot determine the source database"),
      );
      expect(await fs.readFile(state.configPath, "utf8")).toBe(malformed);
    });
  },
);

it.each(["config", "config+creds+sessions", "full"] as const)(
  "refuses a %s reset before discarding retained PostgreSQL routing",
  async (scope) => {
    resetDatabaseEngineSelectionForTest();
    await withOpenClawTestState({ label: "onboard-reset-pg-anchor" }, async (state) => {
      await state.writeConfig({
        database: {
          engine: "postgres",
          postgres: { connection: "postgresql://127.0.0.1:1/synthetic" },
        },
        plugins: { enabled: false },
      });
      const database = state.statePath("state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(database), { recursive: true });
      {
        using anchor = openNodeSqliteDatabase(database);
        anchor.exec(
          "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
        );
        anchor
          .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)")
          .run("synthetic-store", "postgres", "retained_reset_state");
      }
      const before = await fs.readFile(state.configPath, "utf8");
      vi.spyOn(interactive, "hasInteractiveOnboardingTty").mockReturnValue(true);
      const cleanup = vi.spyOn(helpers, "handleReset").mockImplementation(async () => {
        await fs.unlink(state.configPath);
      });
      vi.spyOn(guided, "runGuidedOnboarding").mockImplementation(async () => {
        beginLocalOnboarding({
          configPath: state.configPath,
          workspace: state.workspaceDir,
          securityAcknowledgedAt: "2026-01-01T00:00:00.000Z",
          runId: "post-reset-onboarding",
        });
      });
      const runtime = createTestRuntime();
      await setupWizardCommand({ reset: true, resetScope: scope }, runtime);
      expect(cleanup).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("PostgreSQL"));
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
    });
  },
);
