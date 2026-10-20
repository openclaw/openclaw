import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  prepareAuthProfileSourceReceipt,
  digestAuthProfileMigrationValue,
  finalizeAuthProfileMigrationSource,
  resumePendingAuthProfileMigrationArchives,
} from "./doctor-auth-migration-receipts.js";

type MigrationReceiptTestApi = {
  recordAuthProfileMigrationImported: (
    receipt: ReturnType<typeof prepareAuthProfileSourceReceipt>,
  ) => void;
  restoreAuthProfileMigrationArchiveNoClobber: (
    receipt: ReturnType<typeof prepareAuthProfileSourceReceipt>,
  ) => "restored" | "source-exists";
};

const { recordAuthProfileMigrationImported, restoreAuthProfileMigrationArchiveNoClobber } = (
  globalThis as Record<PropertyKey, unknown>
)[Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")] as MigrationReceiptTestApi;

function expectStatus(receipt: ReturnType<typeof prepareAuthProfileSourceReceipt>, status: string) {
  const row = openOpenClawStateDatabase({ env: receipt.env })
    .db.prepare("SELECT status FROM migration_sources WHERE source_key = ?")
    .get(receipt.sourceKey);
  expect(row).toEqual({ status });
}

function rollbackTarget(
  receipt: ReturnType<typeof prepareAuthProfileSourceReceipt>,
  value: unknown,
) {
  fs.mkdirSync(path.dirname(receipt.targetDatabasePath), { recursive: true });
  using target = new DatabaseSync(receipt.targetDatabasePath);
  const kind = receipt.targetTable === "auth_profile_state" ? "state" : "store";
  target.exec(
    `CREATE TABLE ${receipt.targetTable} (${kind}_key TEXT PRIMARY KEY, ${kind}_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  target
    .prepare(`INSERT INTO ${receipt.targetTable} VALUES ('primary', ?, 1)`)
    .run(JSON.stringify(value));
  recordAuthProfileMigrationImported(receipt);
  if (kind === "store") {
    // Model a crash after the source rename but before the receipt completes.
    fs.renameSync(receipt.sourcePath, receipt.archivePath);
  }
  target.prepare(`DELETE FROM ${receipt.targetTable}`).run();
}

describe("auth profile migration receipts", () => {
  const states: OpenClawTestState[] = [];

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    for (const state of states.splice(0)) {
      await state.cleanup();
    }
  });

  async function makeReceipt() {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-auth-receipt-",
    });
    states.push(state);
    const sourcePath = await state.writeText(
      "credentials/oauth.json",
      `${JSON.stringify({ openai: { access: "fake", refresh: "fake", expires: 42 } })}\n`,
    );
    const receipt = prepareAuthProfileSourceReceipt({
      pathname: sourcePath,
      targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      targetTable: "auth_profile_store",
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      env: state.env,
    });
    return { state, sourcePath, receipt };
  }

  it("restores an archive for retry when its SQLite target was rolled back", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    const profileValue = { type: "oauth", provider: "openai", refresh: "not-a-real" };
    receipt.expectedProfileSha256 = {
      "openai:default": digestAuthProfileMigrationValue(profileValue),
    };
    rollbackTarget(receipt, { version: 1, profiles: { "openai:default": profileValue } });

    expect(resumePendingAuthProfileMigrationArchives(state.env)).toEqual([
      "Reset an interrupted auth migration receipt for retry.",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(receipt.archivePath)).toBe(false);
    expectStatus(receipt, "retryable");
  });

  it("does not overwrite a source recreated before archive restoration", async () => {
    const { sourcePath, receipt } = await makeReceipt();
    fs.renameSync(receipt.sourcePath, receipt.archivePath);
    fs.writeFileSync(sourcePath, '{"newer":true}\n', "utf8");

    expect(restoreAuthProfileMigrationArchiveNoClobber(receipt)).toBe("source-exists");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"newer":true}\n');
    expect(fs.existsSync(receipt.archivePath)).toBe(true);
  });

  it("does not archive bytes that changed after verification", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    recordAuthProfileMigrationImported(receipt);
    fs.writeFileSync(sourcePath, '{"changed":true}\n', "utf8");

    expect(resumePendingAuthProfileMigrationArchives(state.env)).toEqual([
      "Retired an interrupted auth migration receipt for a changed source.",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(receipt.archivePath)).toBe(false);
    expectStatus(receipt, "superseded");
  });

  it("revalidates target state before resuming an archive", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    receipt.targetTable = "auth_profile_state";
    const persistedState = {
      version: 1,
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    };
    receipt.expectedStateSha256 = digestAuthProfileMigrationValue(persistedState);
    rollbackTarget(receipt, persistedState);

    expect(resumePendingAuthProfileMigrationArchives(state.env)).toEqual([
      "Reset an interrupted auth migration receipt for retry.",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it.each(["imported", "completed"])(
    "does not replace a %s receipt owned by another run",
    async (status) => {
      const { receipt } = await makeReceipt();
      recordAuthProfileMigrationImported(receipt);
      if (status === "completed") {
        finalizeAuthProfileMigrationSource(receipt);
      }
      const replay = { ...receipt, runId: `${receipt.sourceKey}:replay` };

      expect(() => recordAuthProfileMigrationImported(replay)).toThrow(
        `auth profile migration source already owned by ${status} receipt`,
      );
    },
  );

  it("preserves archived-unparsed status when resuming after rename", async () => {
    const { state, receipt } = await makeReceipt();
    receipt.completionStatus = "archived-unparsed";
    recordAuthProfileMigrationImported(receipt);
    fs.renameSync(receipt.sourcePath, receipt.archivePath);

    resumePendingAuthProfileMigrationArchives(state.env);
    expectStatus(receipt, "archived-unparsed");
  });
});
