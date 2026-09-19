import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { DoctorStateMigrationRefusalError } from "./state-migrations.messages.js";
import type { LegacyStateMigrationStepReceipt } from "./state-migrations.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  });
});

function fixture() {
  const root = tempDirs.make("openclaw-blocked-migration-receipts-");
  const stateDir = path.join(root, "state");
  const bundledRoot = path.join(root, "extensions");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(bundledRoot);
  const configPath = path.join(root, "openclaw.json");
  const cfg = { agents: { ownership: "explicit" as const, entries: { planner: {} } } };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
  const env = {
    ...process.env,
    HOME: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return {
    bundledRoot,
    env,
    params: { cfg, env, homedir: () => root, legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES },
  };
}

describe("blocked migration receipt provenance", () => {
  it("names the plugin refusal on the adjacent automatic-only step and Doctor error", async () => {
    const { bundledRoot, params } = fixture();
    const pluginRoot = path.join(bundledRoot, "refusing-owner");
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "refusing-owner",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        doctorContract: { stateMigrations: [{ id: "declared-action" }] },
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default { register() {} };\n");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.ts"),
      `export const stateMigrations = [{
  id: "undeclared-action",
  label: "Unexpected migration",
  detectLegacyState: () => null,
  migrateLegacyState: () => { throw new Error("unapproved migration ran"); },
}];\n`,
    );
    const emitted: LegacyStateMigrationStepReceipt[] = [];
    const result = await autoMigrateLegacyState({
      ...params,
      onStepReceipt: (receipt) => emitted.push(receipt),
    });
    const blockerIndex = result.stepReceipts.findIndex((step) => step.id === "plugin-doctor-state");
    const primaryMessage =
      "Refused plugin migrations that do not match the immutable action order and authority declared by refusing-owner.";
    expect(result.mode).toBe("automatic");
    expect(result.stepReceipts[blockerIndex]).toMatchObject({
      outcome: "refused",
      refusal: { code: "step-refused", message: primaryMessage },
    });
    const blocked = result.stepReceipts[blockerIndex + 1];
    expect(blocked).toMatchObject({
      id: "legacy-main-session-keys",
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
      originatingRefusal: {
        stepId: "plugin-doctor-state",
        code: "step-refused",
        message: primaryMessage,
      },
    });
    expect(emitted.find((receipt) => receipt.id === blocked?.id)).toEqual(blocked);
    const error = new DoctorStateMigrationRefusalError(result.stepReceipts);
    expect(error.message).toContain("Resolve the reported migration failure before retrying");
    expect(error.stepReceipts.find((receipt) => receipt.id === blocked?.id)).toEqual(blocked);
  });

  it.each([
    { kind: "returned", code: "step-refused", message: "uses newer schema version 999" },
    { kind: "thrown", code: "step-threw", message: "Schema inspection is unavailable" },
  ])(
    "carries a $kind schema refusal through preparation to the automatic tail",
    async (failure) => {
      const { env, params } = fixture();
      if (failure.kind === "returned") {
        const databasePath = resolveOpenClawStateSqlitePath(env);
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec("PRAGMA user_version = 999");
        database.close();
      } else {
        vi.spyOn(stateDatabase, "repairOpenClawStateDatabaseSchemaIfNeeded").mockImplementationOnce(
          () => {
            throw new Error(failure.message);
          },
        );
      }
      const receipts: LegacyStateMigrationStepReceipt[] = [];

      await expect(
        autoMigrateLegacyState({ ...params, onStepReceipt: (receipt) => receipts.push(receipt) }),
      ).rejects.toThrow(failure.message);
      expect(receipts.find((receipt) => receipt.id === "legacy-main-session-keys")).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
        originatingRefusal: {
          stepId: "state-schema",
          code: failure.code,
          message: expect.stringContaining(failure.message),
        },
      });
    },
  );

  it("carries a prelude refusal into every later Doctor receipt", async () => {
    const { params } = fixture();
    const result = await autoMigrateLegacyState({
      ...params,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: { surfaces: [], failures: ["Session migration owner is unavailable"] },
    });
    const blockerIndex = result.stepReceipts.findIndex(
      (receipt) => receipt.id === "plugin-migration-preparation",
    );
    expect(blockerIndex).toBeGreaterThanOrEqual(0);
    for (const receipt of result.stepReceipts.slice(blockerIndex + 1)) {
      expect(receipt).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
        originatingRefusal: {
          stepId: "plugin-migration-preparation",
          code: "step-refused",
          message: "Session migration owner is unavailable",
        },
      });
    }
    expect(
      result.stepReceipts.findIndex((receipt) => receipt.id === "exec-approvals"),
    ).toBeGreaterThan(blockerIndex);
  });
});
