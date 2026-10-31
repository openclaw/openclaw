import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginDoctorStateMigration } from "./doctor-contract-module.js";
import { preparePluginDoctorMigrationResources } from "./doctor-migration-resources.js";

const fixtureMigration: PluginDoctorStateMigration = {
  id: "resource-fixture",
  label: "Fixture state",
  detectLegacyState: () => null,
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
};
const input = { config: {}, env: {}, stateDir: "/synthetic/state", warnings: [] };

it("cancels a stalled read-only inventory before admitting later plugin resources", async () => {
  const controller = new AbortController();
  const pending = createDeferredCore<[]>();
  const later = vi.fn(() => []);
  const result = preparePluginDoctorMigrationResources(
    [
      {
        pluginId: "stalled",
        migration: { ...fixtureMigration, collectBackupResources: () => pending.promise },
      },
      { pluginId: "later", migration: { ...fixtureMigration, collectBackupResources: later } },
    ],
    { ...input, signal: controller.signal },
  ).catch((error: unknown) => error);
  controller.abort(new Error("Original-state capture timed out"));
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
  expect(await result).toMatchObject({
    message: expect.stringContaining("stalled/resource-fixture"),
  });
  pending.resolve([]);
  await new Promise(setImmediate);
  expect(later).not.toHaveBeenCalled();
});
