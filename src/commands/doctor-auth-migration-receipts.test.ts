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

function rollbackTarget(value: unknown) {
  fs.mkdirSync(path.dirname(receipt.targetDatabasePath), { recursive: true });
  using target = new DatabaseSync(receipt.targetDatabasePath);
  const kind = receipt.targetTable === "auth_profile_state" ? "state" : "store";
  target.exec(
    `CREATE TABLE ${receipt.targetTable} (${kind}_key TEXT PRIMARY KEY, ${kind}_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  target
    .prepare(`INSERT INTO ${receipt.targetTable} VALUES ('primary', ?, 1)`)
    .run(JSON.stringify(value));
  record(receipt);
  if (kind === "store") {
    // Model a crash after the source rename but before the receipt completes.
    fs.renameSync(receipt.sourcePath, receipt.archivePath);
  }
  target.prepare(`DELETE FROM ${receipt.targetTable}`).run();
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state?.cleanup();
});

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "openclaw-auth-receipt-" });
  const sourcePath = await state.writeText("credentials/oauth.json", '{"openai":{}}\n');
  receipt = prepareReceipt({
    pathname: sourcePath,
    targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    targetTable: "auth_profile_store",
    now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    env: state.env,
  });
});

it.each(["store", "state"] as const)("retries a rolled-back %s", (kind) => {
  receipt.targetTable = `auth_profile_${kind}`;
  const profileValue = { refresh: "not-a-real" };
  const value =
    kind === "store"
      ? { version: 1, profiles: { "openai:default": profileValue } }
      : { version: 1, order: { openai: ["openai:default"] } };
  if (kind === "store") {
    receipt.expectedProfileSha256 = { "openai:default": digest(profileValue) };
  } else {
    receipt.expectedStateSha256 = digest(value);
  }
  rollbackTarget(value);
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
