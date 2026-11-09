import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  prepareAuthProfileSourceReceipt as prepareReceipt,
  digestAuthProfileMigrationValue as digest,
  finalizeAuthProfileMigrationSource as finalize,
  resumePendingAuthProfileMigrationArchives as resume,
} from "./doctor-auth-migration-receipts.js";

type Receipt = ReturnType<typeof prepareReceipt>;
type MigrationReceiptTestApi = {
  recordAuthProfileMigrationImported: (receipt: Receipt) => void;
  restoreAuthProfileMigrationArchiveNoClobber: (receipt: Receipt) => "restored" | "source-exists";
};

const {
  recordAuthProfileMigrationImported: record,
  restoreAuthProfileMigrationArchiveNoClobber: restore,
} = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")
] as MigrationReceiptTestApi;

let state: OpenClawTestState;
let receipt: Receipt;

function expectStatus(status: string) {
  const row = openOpenClawStateDatabase({ env: receipt.env })
    .db.prepare("SELECT status FROM migration_sources WHERE source_key = ?")
    .get(receipt.sourceKey);
  expect(row).toEqual({ status });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state?.cleanup();
});

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "openclaw-auth-receipt-" });
  receipt = prepareReceipt({
    pathname: await state.writeText("credentials/oauth.json", '{"openai":{}}\n'),
    targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    targetTable: "auth_profile_store",
    now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    env: state.env,
  });
});

// Store rollback and archive restoration are exercised by doctor-auth-shared-receipt.test.ts.
it("retries a rolled-back state", () => {
  receipt.targetTable = "auth_profile_state";
  receipt.expectedStateSha256 = digest({ version: 1, order: { openai: ["openai:default"] } });
  fs.mkdirSync(path.dirname(receipt.targetDatabasePath), { recursive: true });
  using target = new DatabaseSync(receipt.targetDatabasePath);
  // A rolled-back target has its schema but no imported row.
  target.exec(
    "CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  record(receipt);
  expect(resume(state.env)).toEqual(["Reset an interrupted auth migration receipt for retry."]);
  expect(fs.existsSync(receipt.sourcePath)).toBe(true);
  expect(fs.existsSync(receipt.archivePath)).toBe(false);
  expectStatus("retryable");
});

it("does not overwrite a source recreated before archive restoration", () => {
  fs.renameSync(receipt.sourcePath, receipt.archivePath);
  fs.writeFileSync(receipt.sourcePath, '{"newer":true}\n', "utf8");

  expect(restore(receipt)).toBe("source-exists");
  expect(fs.readFileSync(receipt.sourcePath, "utf8")).toBe('{"newer":true}\n');
  expect(fs.existsSync(receipt.archivePath)).toBe(true);
});

it("does not archive bytes that changed after verification", () => {
  record(receipt);
  fs.writeFileSync(receipt.sourcePath, '{"changed":true}\n', "utf8");

  expect(resume(state.env)).toEqual([
    "Retired an interrupted auth migration receipt for a changed source.",
  ]);
  expect(fs.existsSync(receipt.sourcePath)).toBe(true);
  expect(fs.existsSync(receipt.archivePath)).toBe(false);
  expectStatus("superseded");
});

it.each(["imported", "completed"])("rejects %s receipt replacement", (status) => {
  record(receipt);
  if (status === "completed") {
    finalize(receipt);
  }
  expect(() => record({ ...receipt, runId: "competing-run" })).toThrow(
    `auth profile migration source already owned by ${status} receipt`,
  );
});

it("preserves archived-unparsed status when resuming after rename", () => {
  receipt.completionStatus = "archived-unparsed";
  record(receipt);
  fs.renameSync(receipt.sourcePath, receipt.archivePath);

  resume(state.env);
  expectStatus("archived-unparsed");
});
