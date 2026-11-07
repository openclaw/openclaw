import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseEngineSelection } from "../../infra/database-engine/types.js";

const cpu = vi.hoisted(() => ({ count: 16 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => cpu.count,
}));

afterEach(async () => {
  const { resetDatabaseEngineSelectionForTest } =
    await import("../../infra/database-engine/context.test-support.js");
  resetDatabaseEngineSelectionForTest();
  vi.resetModules();
});

function selection(agent: "sqlite" | "postgres"): DatabaseEngineSelection {
  return {
    effectiveEngines: {
      state: agent,
      agent,
      workboard: agent,
      logbook: agent,
      "team-reports": agent,
      quarantine: agent,
      "managed-update": agent,
      "package-activation": agent,
    },
    ...(agent === "postgres"
      ? { postgres: { connection: "postgres://fixture", schemaPrefix: "fixture" } }
      : {}),
  };
}

it.each([
  ["sqlite", 2],
  ["postgres", 4],
] as const)(
  "sizes the history lane from the %s engine installed after import",
  async (engine, expected) => {
    // Boot imports the lane before it resolves configuration and installs the engine.
    const { historyLane, transcriptSearchLane } =
      await import("./session-transcript-worker-resources.js");
    const { installDatabaseEngineSelection } =
      await import("../../infra/database-engine/context.js");
    installDatabaseEngineSelection(selection(engine));

    expect(historyLane.pool.getSnapshot().maxWorkers).toBe(expected);
    expect(transcriptSearchLane.pool.getSnapshot().maxWorkers).toBe(2);
  },
);
