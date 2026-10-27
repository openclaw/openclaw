import fs from "node:fs/promises";
import path from "node:path";
import { aroundEach, expect, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../../test/helpers/managed-handoff-isolation.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import * as handoffDatabase from "../../infra/update-managed-service-handoff-database.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

export const validConfigSnapshot = createTestConfigSnapshot({}, {});

export const successfulPluginUpdate = createPostCorePluginUpdateResult({
  status: "ok",
  changed: true,
  warnings: [],
});

export function expectLifecycleBoundary(events: readonly string[], preLeaseEvent: string): void {
  const preLeaseIndex = events.indexOf(`${preLeaseEvent}:false`);
  expect(preLeaseIndex).toBeGreaterThan(-1);
  expect(events).not.toContain(`${preLeaseEvent}:true`);
  const authoritativeReadIndex = events.findIndex(
    (event, index) => index > preLeaseIndex && event === "read-config:true",
  );
  expect(authoritativeReadIndex).toBeGreaterThan(preLeaseIndex);
  expect(events).toEqual(
    expect.arrayContaining(["prepare-config:true", "installed-records:true", "plugin-update:true"]),
  );
  expect(events.indexOf("plugin-update:true")).toBeGreaterThan(authoritativeReadIndex);
}

export const finalizationCleanupCases = [
  { phase: "preflight", cleanup: "forced", failed: false },
  { phase: "preflight", cleanup: "uncertain", failed: false },
  { phase: "completion", cleanup: "forced", failed: false },
  { phase: "completion", cleanup: "uncertain", failed: false },
  { phase: "completion", cleanup: "forced", failed: true },
  { phase: "completion", cleanup: "uncertain", failed: true },
  { phase: "recovery", cleanup: "forced", failed: true },
  { phase: "recovery", cleanup: "uncertain", failed: true },
] as const;

export async function prepareFinalizationPackage(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
}

/** Every registered lifecycle case keeps its real databases and private control scope. */
export function registerPrivateHandoffBindingTests() {
  const dirs = createTempDirTracker();
  let binding: ReturnType<typeof createManagedHandoffTestBinding>;
  const bindPath =
    <Args extends [string, ...unknown[]], Result>(open: (...args: Args) => Result) =>
    (...args: Args): Result => {
      binding.assertPath(args[0]);
      return open(...args);
    };
  aroundEach(async (runTest) => {
    binding = createManagedHandoffTestBinding(dirs.make("update-lifecycle-control-"));
    const resolveTemp = vi
      .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
      .mockImplementation(() => {
        binding.assertPath();
        return binding.directory;
      });
    const createDatabase = bindPath(handoffDatabase.createManagedHandoffLeaseDatabase);
    const database = vi
      .spyOn(handoffDatabase, "createManagedHandoffLeaseDatabase")
      .mockImplementation(createDatabase);
    const prepareDatabase = bindPath(handoffDatabase.prepareManagedHandoffLeaseDatabase);
    const preparedDatabase = vi
      .spyOn(handoffDatabase, "prepareManagedHandoffLeaseDatabase")
      .mockImplementation(prepareDatabase);
    try {
      expect(resolveManagedUpdateLeaseDatabasePath()).toBe(binding.databasePath);
      await runTest();
    } finally {
      preparedDatabase.mockRestore();
      database.mockRestore();
      resolveTemp.mockRestore();
      dirs.cleanup();
    }
  });
}
