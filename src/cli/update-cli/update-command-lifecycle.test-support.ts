import fs from "node:fs/promises";
import path from "node:path";
import { aroundEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../../test/helpers/managed-handoff-isolation.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../../infra/state-database-coordinator.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import * as handoffDatabase from "../../infra/update-managed-service-handoff-database.js";
import {
  resolveManagedUpdateLeaseDatabasePath,
  createManagedHandoffLeaseStore,
} from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { resolveUpdateRoot } from "./shared.js";
import {
  withUpdateCommandExecutor,
  captureUpdateCommandExecutorAuthority,
} from "./update-command-executor.js";

export const validConfigSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  resolved: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

export const successfulPluginUpdate = {
  status: "ok" as const,
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

export function expectLifecycleBoundary(events: readonly string[], preLeaseEvent: string): void {
  const preLeaseIndex = events.indexOf(`${preLeaseEvent}:false`);
  expect(preLeaseIndex).toBeGreaterThan(-1);
  expect(events).not.toContain(`${preLeaseEvent}:true`);
  const authoritativeReadIndex = events.findIndex(
    (event, index) => index > preLeaseIndex && event === "read-config:true",
  );
  expect(authoritativeReadIndex).toBeGreaterThan(preLeaseIndex);
  for (const event of ["prepare-config:true", "installed-records:true", "plugin-update:true"]) {
    expect(events).toContain(event);
  }
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
  aroundEach(async (runTest) => {
    binding = createManagedHandoffTestBinding(dirs.make("update-lifecycle-control-"));
    const resolveTemp = vi
      .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
      .mockImplementation(() => {
        binding.assertPath();
        return binding.directory;
      });
    const createDatabase = handoffDatabase.createManagedHandoffLeaseDatabase;
    const database = vi
      .spyOn(handoffDatabase, "createManagedHandoffLeaseDatabase")
      .mockImplementation((file, identity) => {
        binding.assertPath(file);
        return createDatabase(file, identity);
      });
    try {
      expect(resolveManagedUpdateLeaseDatabasePath()).toBe(binding.databasePath);
      await withStateDatabaseCoordinatorRuntimeDirectory(binding.directory, runTest);
    } finally {
      database.mockRestore();
      resolveTemp.mockRestore();
      dirs.cleanup();
    }
  });
  it.each([false, true])(
    "binds the real executor before opening its store (missing=%s)",
    async (missing) => {
      const root = await resolveUpdateRoot();
      const wrongDirectory = dirs.make("update-lifecycle-unbound-");
      if (missing)
        vi.mocked(tempRoot.resolvePreferredOpenClawTmpDir).mockReturnValue(wrongDirectory);
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      const run = createUpdateRun({ trigger: "cli" });
      const operation = withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(root);
        expect(captureUpdateCommandExecutorAuthority(fence).databasePath).toBe(
          binding.databasePath,
        );
        expect(createManagedHandoffLeaseStore().read(root)).toMatchObject({ kind: "current" });
      });
      if (missing) {
        await expect(operation).rejects.toMatchObject({
          code: "ERR_ASSERTION",
          actual: path.join(wrongDirectory, "managed-update-handoffs.sqlite"),
          expected: binding.databasePath,
        });
        expect(await fs.readdir(wrongDirectory)).toEqual([]);
      } else {
        await operation;
        expect((await fs.stat(binding.assertPath())).isFile()).toBe(true);
        expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
      }
    },
  );
}
