import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const postgres = { connection: "postgresql://127.0.0.1:1/synthetic", schemaPrefix: "reset_source" };
const unresolved = { source: "env" as const, provider: "default", id: "RESET_TEST_DSN" };
beforeEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.spyOn(interactive, "hasInteractiveOnboardingTty").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDatabaseEngineSelectionForTest();
});

function mockCleanup(configPath: string) {
  return vi.spyOn(helpers, "handleReset").mockImplementation(async () => {
    expect(getScopedDatabaseEngineSelection()).toBeUndefined();
    await fs.unlink(configPath);
  });
}
it.each(["config+creds+sessions", "config"] as const)("selects SQLite: %s", async (scope) => {
  await withOpenClawTestState({ env: { RESET_TEST_DSN: undefined } }, async (state) => {
    await state.writeConfig({
      database: {
        engine: "sqlite",
        postgres: {
          ...postgres,
          connection: scope === "config" ? unresolved : postgres.connection,
        },
      },
      plugins: { enabled: false },
    });
    const cleanup = mockCleanup(state.configPath);
    const setup = vi.spyOn(guided, "runGuidedOnboarding").mockImplementation(async () => {
      expect(getScopedDatabaseEngineSelection()).toBeUndefined();
      expect(getDatabaseEngineSelection()?.effectiveEngines.state).toBe("sqlite");
    });
    await setupWizardCommand({ reset: true, resetScope: scope }, createTestRuntime());
    [cleanup, setup].forEach((mock) => expect(mock).toHaveBeenCalledOnce());
  });
});

it.each([
  ["malformed", "config+creds+sessions"],
  ["malformed", "full"],
  ["malformed", "config"],
  ["postgres", "config"],
  ["postgres", "config+creds+sessions"],
  ["postgres", "full"],
] as const)("refuses %s source state before %s reset", async (source, scope) => {
  await withOpenClawTestState({}, async (state) => {
    if (source === "malformed") {
      await fs.writeFile(state.configPath, '{ database: { engine: "postgres",');
    } else {
      await state.writeConfig({
        database: { engine: "postgres", postgres },
        plugins: { enabled: false },
      });
      const database = state.statePath("state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(database), { recursive: true });
      using anchor = openNodeSqliteDatabase(database);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT);" +
          "INSERT INTO openclaw_engine_anchor VALUES ('synthetic-store', 'postgres', 'retained_reset_state');",
      );
    }
    const before = await fs.readFile(state.configPath, "utf8");
    const cleanup = mockCleanup(state.configPath);
    const setup = vi.spyOn(guided, "runGuidedOnboarding").mockImplementation(async () => {
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
    expect(setup).not.toHaveBeenCalled();
    const message = source === "malformed" ? "Cannot determine the source database" : "PostgreSQL";
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
  });
});
