import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  deleteSecretStoreEntry,
  getSecretStoreMutationsVersion,
  readSecretStoreExecEnvironment,
  updateSecretStoreAllowedHosts,
  writeSecretStoreEntry,
  writeSecretStoreEntryWithRollback,
} from "./secret-store.js";

/** Covers the store mutation version that exec-run uses to invalidate its
 * per-instance store environment snapshot (#152409). */

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { kind: "team" } as const;

afterEach(() => closeOpenClawStateDatabaseForTest());

function fixtureDb() {
  const stateDir = tempDirs.make("openclaw-store-version-");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const database = { env };
  openOpenClawStateDatabase(database);
  return database;
}

describe("secret store mutations version", () => {
  it("stays stable without mutations and bumps on write", () => {
    fixtureDb();
    const v0 = getSecretStoreMutationsVersion();
    writeSecretStoreEntry({
      scope,
      name: "META_ADS_ACCESS_TOKEN",
      value: "EAAG-token",
      kind: "secret",
      allowedHosts: ["graph.facebook.com"],
      updatedBy: "test",
    });
    expect(getSecretStoreMutationsVersion()).toBeGreaterThan(v0);
    const v1 = getSecretStoreMutationsVersion();
    // a read must not bump
    readSecretStoreExecEnvironment({ includeSecretSentinels: true });
    expect(getSecretStoreMutationsVersion()).toBe(v1);
  });

  it("bumps on allowed-hosts update, delete, and rollback write", () => {
    fixtureDb();
    writeSecretStoreEntry({
      scope,
      name: "OTHER_SERVICE_KEY",
      value: "token-2",
      kind: "secret",
      allowedHosts: ["git.example.com"],
      updatedBy: "test",
    });
    const v0 = getSecretStoreMutationsVersion();
    updateSecretStoreAllowedHosts({
      scope,
      name: "OTHER_SERVICE_KEY",
      allowedHosts: ["other.example.com"],
      updatedBy: "test",
    });
    expect(getSecretStoreMutationsVersion()).toBeGreaterThan(v0);
    const v1 = getSecretStoreMutationsVersion();
    const writer = writeSecretStoreEntryWithRollback({
      scope,
      name: "OTHER_SERVICE_KEY",
      value: "token-3",
      kind: "secret",
      updatedBy: "test",
    });
    expect(getSecretStoreMutationsVersion()).toBeGreaterThan(v1);
    writer.rollback();
    const v2 = getSecretStoreMutationsVersion();
    // P2 review fix: a successful rollback changes the store, so it must advance
    // the version - otherwise exec snapshots created during the staged window keep
    // serving the compensated credential until some unrelated mutation.
    expect(getSecretStoreMutationsVersion()).toBeGreaterThan(v1);
    deleteSecretStoreEntry({ scope, name: "OTHER_SERVICE_KEY" });
    expect(getSecretStoreMutationsVersion()).toBeGreaterThan(v2);
  });
});
