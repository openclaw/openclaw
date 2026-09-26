import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "../cli/update-cli/update-command-executor.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import {
  capturePackageReverseExecutor,
  assertPackageReverseExecutor,
} from "./package-update-reverse-authority.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as runtimeWorker from "./runtime-worker-url.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";
import { withUpdateInitialStoreInvocation } from "./update-initial-store-invocation.js";
import { createManagedHandoffLeaseDatabase } from "./update-managed-service-handoff-database.js";

const identity = (file: string) => {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

// Real native original executor/maintenance and real lower swap/preparation.
// Only the sealed helper and target capability probe are inert fixtures. This
// is NOT installed runtime/startup, automatic C-to-T or fullCLI acceptance.
it
  .skipIf(process.platform === "win32")
  .each(["ordinary", "selected", "descendant", "rollback"] as const)(
  "retains the real original provider and native guards (control: %s)",
  async (mode) => {
    const selectedPair = mode !== "ordinary";
    const base = process.env.OPENCLAW_NATIVE_PROVIDER_TEST_ROOT ?? fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(base)).toBe(base);
    const root = fs.mkdtempSync(path.join(base, "real-provider-"));
    fs.chmodSync(root, 0o700);
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    let retained: ReturnType<typeof capturePackageReverseExecutor> | undefined;
    let runId: string;
    try {
      const f = await createPackageSwapFixture(root);
      const stateDir = path.join(root, "state");
      const coordinator = path.join(root, "coordinator");
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.mkdirSync(coordinator, { mode: 0o700 });
      const state = path.join(stateDir, "openclaw.sqlite");
      const db = new DatabaseSync(state);
      try {
        db.exec(
          "CREATE TABLE acknowledged(value TEXT); INSERT INTO acknowledged VALUES ('newer write')",
        );
      } finally {
        db.close();
      }
      fs.chmodSync(state, 0o600);
      const handoff = path.join(root, "handoff.sqlite");
      createManagedHandoffLeaseDatabase(handoff)(true, () => {});
      const select = (file: string) => ({
        databasePath: file,
        databaseIdentity: identity(file),
        parentIdentity: identity(path.dirname(file)),
      });
      const selection = {
        privateRoot: { path: root, identity: identity(root) },
        installation: { path: f.packageRoot, identity: identity(f.packageRoot) },
        handoff: select(handoff),
        state: select(state),
      };
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      const helper = path.join(root, "sealed.mjs");
      fs.writeFileSync(helper, "// inert sealed helper bytes\n");
      const originalResolve = runtimeWorker.resolveRuntimeWorkerUrl;
      vi.spyOn(runtimeWorker, "resolveRuntimeWorkerUrl").mockImplementation((entry) =>
        entry.sourceWorkerName === "package-update-activation-sealed"
          ? pathToFileURL(helper)
          : originalResolve(entry),
      );
      const probe = path.join(
        f.params.stage.packageRoot,
        "dist/infra/update-migrated-finalize.worker.js",
      );
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      // The child receives no ambient environment: install the pre-open guard in
      // its actual entry before it can import/open any SQLite.
      fs.writeFileSync(
        probe,
        `const sqlite = require("node:sqlite"); sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {construct() {throw new Error("Capability probe must not open SQLite");}}); require("node:module").syncBuiltinESMExports(); console.log(JSON.stringify({postCoreExecutor:"fd3-pid-start-v1",mutationProtocol:"original-cancellation-v1"}));
`,
      );
      fs.writeFileSync(
        path.join(f.packageRoot, "dist/build-info.json"),
        JSON.stringify({ buildId: "native-lower-fixture", commit: "a".repeat(40) }),
      );
      runId = randomUUID();
      const work = withStateDatabaseCoordinatorRuntimeDirectory(coordinator, () =>
        maintenance.run(() =>
          withUpdateInitialStoreInvocation(
            selectedPair ? { version: 1, selection } : undefined,
            () =>
              withUpdateCommandExecutor(
                runId,
                async (executor) => {
                  const fence = await executor.enter(f.packageRoot);
                  if (selectedPair) {
                    retained = capturePackageReverseExecutor(fence, runId);
                    if (mode === "descendant") {
                      // No helper is spawned: prove exclusion while native child
                      // admission is outstanding, then require its refused-start cleanup.
                      await expect(
                        withUpdateCommandExecutorChild(fence, f.packageRoot, async () => {
                          expect(() =>
                            assertPackageReverseExecutor(retained!, runId, false),
                          ).toThrow("The update process is still running.");
                        }),
                      ).rejects.toThrow("The update worker did not confirm startup.");
                      assertPackageReverseExecutor(retained!, runId, false);
                      return;
                    }
                  } else {
                    expect(() => capturePackageReverseExecutor(fence, runId)).toThrow(
                      /direct original/,
                    );
                  }
                  expect(() => capturePackageReverseExecutor({ ...fence }, runId)).toThrow(
                    /admitted executor/,
                  );
                  expect(() =>
                    assertPackageReverseExecutor(
                      { ...retained! } as NonNullable<typeof retained>,
                      runId,
                      false,
                    ),
                  ).toThrow(/captured native/);
                  let transaction: PackageUpdateTransaction | undefined;
                  const result = await swapStagedPackageInstall({
                    ...f.params,
                    assertCurrent: fence.assertCurrent,
                    activation: {
                      fence,
                      runId,
                      nodeRunner: process.execPath,
                      onPrepared: () => {},
                    },
                    onTransaction: (value) => {
                      transaction = value;
                    },
                  });
                  expect(result.status, JSON.stringify(result)).toBe("committed");
                  expect(transaction?.reversePublication).toBeDefined();
                  if (selectedPair) {
                    expect(transaction!.reversePublication!.selection().originalRunId).toBe(runId);
                  } else {
                    expect(() => transaction!.reversePublication!.selection()).toThrow(
                      /live registered executor/,
                    );
                  }
                  fence.assertCurrent();
                  if (mode === "rollback") {
                    const journal = openPackageActivationJournal(
                      resolvePackageActivationAnchor(f.packageRoot),
                    );
                    const before = journal.read();
                    const candidate = identity(f.packageRoot);
                    const rollback = await transaction!
                      .rollback(fence.assertCurrent)
                      .catch((error: unknown) => error);
                    expect(fs.existsSync(f.packageRoot)).toBe(true);
                    expect(identity(f.packageRoot)).toBe(candidate);
                    expect(journal.read()).toEqual(before);
                    expect(rollback).toBeInstanceOf(Error);
                    expect(rollback).toMatchObject({
                      message: expect.stringMatching(/native reverse/),
                    });
                    expect(transaction!.reversePublication!.selection().originalRunId).toBe(runId);
                    fence.assertCurrent();
                    return;
                  }
                  {
                    await expect(
                      transaction!.complete({ activationVerified: true }, fence.assertCurrent),
                    ).resolves.toBeUndefined();
                    await expect(
                      transaction!.complete({ activationVerified: true }, fence.assertCurrent),
                    ).resolves.toBeUndefined();
                    // Reuse the original completed slot under the SAME executor.
                    // The old transaction must keep its cached completion, not
                    // re-admit its now-replaced receipt as the current operation.
                    await writePackageRoot(f.params.stage.packageRoot, "3.0.0");
                    fs.mkdirSync(path.dirname(probe), { recursive: true });
                    fs.writeFileSync(
                      probe,
                      `const sqlite = require("node:sqlite"); sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {construct() {throw new Error("Capability probe must not open SQLite");}}); require("node:module").syncBuiltinESMExports(); console.log(JSON.stringify({postCoreExecutor:"fd3-pid-start-v1",mutationProtocol:"original-cancellation-v1"}));`,
                    );
                    fs.mkdirSync(f.params.stage.layout.binDir, { recursive: true });
                    fs.writeFileSync(
                      path.join(f.params.stage.layout.binDir, "openclaw"),
                      "next launcher",
                    );
                    let nextTransaction: PackageUpdateTransaction | undefined;
                    const next = await swapStagedPackageInstall({
                      ...f.params,
                      assertCurrent: fence.assertCurrent,
                      activation: {
                        fence,
                        runId,
                        nodeRunner: process.execPath,
                        onPrepared: () => {},
                      },
                      onTransaction: (value) => {
                        nextTransaction = value;
                      },
                    });
                    expect(next.status, JSON.stringify(next)).toBe("committed");
                    await expect(
                      transaction!.complete({ activationVerified: true }, fence.assertCurrent),
                    ).resolves.toBeUndefined();
                    await expect(
                      nextTransaction!.complete({ activationVerified: true }, fence.assertCurrent),
                    ).resolves.toBeUndefined();
                  }
                },
                {
                  directOriginal: { databasePath: handoff },
                  ...(selectedPair
                    ? { initialStores: { protocol: "initial-pair-v1" as const, selection } }
                    : {}),
                },
              ),
          ),
        ),
      );
      if (mode === "descendant") {
        // The original executor also joins/reports the child failure, even after
        // the caller catches it. Retain this refusal instead of hiding it.
        await expect(work).rejects.toThrow("The update worker did not confirm startup.");
      } else {
        await work;
      }
      if (retained) {
        expect(() => assertPackageReverseExecutor(retained!, runId, false)).toThrow(
          /outlived|no longer|closed/,
        );
      }
    } finally {
      await maintenance.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
