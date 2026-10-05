import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createUpdateRun } from "../update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../update-run-recovery-admission.js";
import {
  mayUpgradeRecipeExternalWorkHaveOccurred,
  type UpgradeRecipeMaintenanceBinding,
} from "./maintenance-contract.js";
import {
  readUpgradeRecipeMaintenanceReceiptInDatabase,
  recordUpgradeRecipeMaintenanceInWorker,
} from "./maintenance-store.js";
import {
  readUpgradeRecipeMaintenanceReceipt,
  createUpgradeRecipeMaintenanceOwner,
} from "./maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);
function fixture() {
  const root = dirs.make("upgrade-maintenance-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const database = openOpenClawStateDatabase(options);
  const run = createUpdateRun({ trigger: "cli" }, options);
  const binding: UpgradeRecipeMaintenanceBinding = {
    protocol: 1,
    runId: run.runId,
    planDigest: "a".repeat(64),
    targetArtifactId: "target",
    installationKey: "/install",
    stateRootKey: root,
  };
  const pathname = database.path;
  closeOpenClawStateDatabaseForTest();
  return { binding, options: { ...options, path: pathname } };
}

it("persists the external-work boundary, rejects stale receipts and conflicting takeover", () => {
  const { binding, options } = fixture();
  const record = (
    phase: "maintenance-required" | "commit-intent" | "committed",
    expectedRevision: number | null,
    selected = binding,
  ) =>
    recordUpgradeRecipeMaintenanceInWorker(
      { binding: selected, phase, expectedRevision },
      options,
      () => {},
    );
  const required = record("maintenance-required", null);
  expect(mayUpgradeRecipeExternalWorkHaveOccurred(required)).toBe(false);
  expect(() => record("committed", required.revision)).toThrow("not admitted");
  expect(() =>
    record("commit-intent", required.revision, { ...binding, targetArtifactId: "other" }),
  ).toThrow("not admitted");
  const intent = record("commit-intent", required.revision);
  expect(mayUpgradeRecipeExternalWorkHaveOccurred(intent)).toBe(true);
  expect(() => record("committed", required.revision)).toThrow("receipt changed");
  const committed = record("committed", intent.revision);
  expect(mayUpgradeRecipeExternalWorkHaveOccurred(committed)).toBe(true);
  const database = openOpenClawStateDatabase(options);
  expect(readUpgradeRecipeMaintenanceReceiptInDatabase(database.db)).toEqual(committed);
});

it("lost commit authority rolls back the receipt write", () => {
  const { binding, options } = fixture();
  expect(() =>
    recordUpgradeRecipeMaintenanceInWorker(
      { binding, phase: "maintenance-required", expectedRevision: null },
      options,
      (stage) => {
        if (stage === "commit") {
          throw new Error("executor lost");
        }
      },
    ),
  ).toThrow("executor lost");
  const database = openOpenClawStateDatabase(options);
  expect(readUpgradeRecipeMaintenanceReceiptInDatabase(database.db)).toBeNull();
});

it("records and verifies exact intent through existing fenced writer and passive reader workers", async () => {
  const { binding, options } = fixture();
  const authority = createUpgradeRecipeMaintenanceOwner(binding, {
    ...options,
    assertCurrent: () => {},
  });
  const required = await authority.requireMaintenance(null);
  await expect(assertUpdateRecoveryAdmission(options)).rejects.toThrow("original update");
  await expect(authority.verifyCommitIntent(binding)).rejects.toThrow(
    "exact durable COMMIT_INTENT",
  );
  const intent = await authority.recordCommitIntent(required.revision);
  await expect(assertUpdateRecoveryAdmission(options)).rejects.toThrow(
    "external work may have occurred",
  );
  expect(await readUpgradeRecipeMaintenanceReceipt(options)).toEqual(intent);
  await authority.verifyCommitIntent(binding);
  await expect(
    authority.verifyCommitIntent({ ...binding, targetArtifactId: "wrong" }),
  ).rejects.toThrow("exact durable COMMIT_INTENT");
  await authority.recordCommitted(intent.revision);
  await assertUpdateRecoveryAdmission(options);
});
