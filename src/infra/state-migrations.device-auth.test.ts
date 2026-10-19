import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeClientCredentialReceipt } from "./client-credential-readiness.js";
import { emptyClientCredentialReceipt } from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { withClientCredentialStore } from "./client-credential-store.test-support.js";
import { readDeviceAuthTokenForTest } from "./device-auth-store.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    cleanup();
  });
});
let stateDir: string;
let env: NodeJS.ProcessEnv;
let sourcePath: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-device-auth-migration-");
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  sourcePath = path.join(stateDir, "identity", "device-auth.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(
    sourcePath,
    JSON.stringify({
      version: 1,
      deviceId: "device-1",
      tokens: {
        " operator ": { token: "stale", scopes: [], updatedAtMs: 1 },
        operator: {
          token: "legacy-token",
          role: "operator",
          scopes: ["operator.write"],
          updatedAtMs: 10,
        },
      },
    }),
  );
});
const readToken = () => readDeviceAuthTokenForTest({ deviceId: "device-1", role: "operator", env });
const migrate = () =>
  migrateLegacyDeviceAuth({
    detected: detectLegacyDeviceAuth({ stateDir, doctorOnlyStateMigrations: true }),
    stateDir,
    env,
  });

describe("legacy device-auth Doctor migration", () => {
  it("imports the last normalized role only with Doctor authority while retaining JSON", async () => {
    expect(detectLegacyDeviceAuth({ stateDir })).toMatchObject({
      sourcePresent: true,
      hasLegacy: false,
    });
    expect(detectLegacyDeviceAuth({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      true,
    );
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated 1 device-auth token to SQLite."]);
    expect(readToken()).toEqual({
      token: "legacy-token",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      updatedAtMs: 10,
    });
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  });

  it("preserves canonical SQLite rows instead of replaying stale JSON", async () => {
    withClientCredentialStore(env, true, (db) => {
      writeClientCredentialReceipt(db, emptyClientCredentialReceipt(), "complete");
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ClientCredentialDatabase>(db).insertInto("device_auth_tokens").values({
          device_id: "device-1",
          role: "operator",
          token: "canonical-token",
          scopes_json: "[]",
          updated_at_ms: 20,
        }),
      );
    });
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    expect(result.notices).toContain("Preserved 1 canonical SQLite device-auth token.");
    expect(readToken()?.token).toBe("canonical-token");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("keeps invalid legacy state for operator repair", async () => {
    fs.writeFileSync(sourcePath, '{"version":2}');
    expect((await migrate()).warnings.join("\n")).toContain("invalid or unsupported");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
  it("does not reimport a revoked token even when retained JSON is edited", async () => {
    const original = fs.readFileSync(sourcePath);
    expect((await migrate()).warnings).toEqual([]);
    expect(
      runClientCredentialOperation(env, {
        kind: "token.remove",
        key: { device_id: "device-1", role: "operator" },
        observedToken: "legacy-token",
      }),
    ).toEqual({ kind: "changed", changed: true });
    fs.writeFileSync(sourcePath, Buffer.concat([original, Buffer.from("edited-invalid-json")]));
    expect((await migrate()).warnings).toEqual([]);
    expect(readToken()).toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
});
