import "../test-utils/prepare-compiled-subprocesses.js";
import os from "node:os";
import { vi } from "vitest";
import {
  closeDatabaseTestCohorts,
  closeStateDatabaseForTest,
} from "../test-utils/database-cleanup.js";

// Partial mocks can retain an earlier database cohort after module reevaluation.
const databaseClosers = new Set([closeStateDatabaseForTest]);

export async function closeUpdateFixtureDatabases(): Promise<void> {
  await closeDatabaseTestCohorts(databaseClosers);
}

export async function resetUpdateFixtureModules(): Promise<void> {
  await closeUpdateFixtureDatabases();
  vi.resetModules();
  // Routine update fixtures start healthy; pressure cases override these host readings.
  vi.spyOn(os, "freemem").mockReturnValue(1024 ** 3);
  vi.spyOn(os, "totalmem").mockReturnValue(1024 ** 3);
  const database = await import("../test-utils/database-cleanup.js");
  databaseClosers.add(database.closeStateDatabaseForTest);
}
