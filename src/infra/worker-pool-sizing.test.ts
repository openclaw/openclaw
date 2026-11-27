import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseEngineSelection } from "./database-engine/types.js";
import { resolveSessionHistoryWorkerCount } from "./worker-pool-sizing.js";

const cpu = vi.hoisted(() => ({ count: 8 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => cpu.count,
}));

afterEach(() => {
  cpu.count = 8;
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
  [2, 1],
  [8, 2],
  [128, 2],
])("keeps SQLite history at the reader size on %i CPUs", (cpus, expected) => {
  cpu.count = cpus;
  expect(resolveSessionHistoryWorkerCount(undefined)).toBe(expected);
  expect(resolveSessionHistoryWorkerCount(selection("sqlite"))).toBe(expected);
});

it.each([
  [2, 2],
  [3, 4],
  [128, 4],
])("sizes PostgreSQL history for blocking reads on %i CPUs", (cpus, expected) => {
  cpu.count = cpus;
  expect(resolveSessionHistoryWorkerCount(selection("postgres"))).toBe(expected);
});

it("sizes history from the agent database family", () => {
  const mixed = selection("sqlite");
  expect(
    resolveSessionHistoryWorkerCount({
      ...mixed,
      effectiveEngines: { ...mixed.effectiveEngines, state: "postgres" },
    }),
  ).toBe(2);
  expect(
    resolveSessionHistoryWorkerCount({
      ...mixed,
      effectiveEngines: { ...mixed.effectiveEngines, agent: "postgres" },
    }),
  ).toBe(4);
});
