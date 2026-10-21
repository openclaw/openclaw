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
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
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
const profiles = [
  ["primary", "device-auth.json"],
  ["node", "node-device-auth.json"],
  ["shareExtension", "share-device-auth.json"],
] as const;
const sourceVariants = profiles.flatMap(([profile, filename]) =>
  ["", ".doctor-importing", ".native-importing"].map(
    (suffix) => [profile, `${filename}${suffix}`] as const,
  ),
);

function selectSource(filename: string) {
  const selected = path.join(stateDir, "identity", filename);
  if (selected !== sourcePath) {
    fs.renameSync(sourcePath, selected);
    sourcePath = selected;
  }
}

describe("legacy device-auth Doctor migration", () => {
  it.each(sourceVariants)(
    "imports %s auth from %s only with Doctor authority while retaining JSON",
    async (_profile, filename) => {
      selectSource(filename);
      const original = fs.readFileSync(sourcePath);
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
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    },
  );

  it.each(profiles)(
    "preserves canonical SQLite rows instead of replaying stale %s JSON",
    async (_profile, filename) => {
      selectSource(filename);
      withClientCredentialStore(env, true, (db) => {
        writeClientCredentialReceipt(db, emptyClientCredentialReceipt(), "complete");
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ClientCredentialDatabase>(db)
            .insertInto("device_auth_tokens")
            .values({
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
    },
  );

  it.each(["", ".doctor-importing", ".native-importing"])(
    "keeps invalid legacy state%s for operator repair",
    async (suffix) => {
      selectSource(`device-auth.json${suffix}`);
      fs.writeFileSync(sourcePath, '{"version":2}');
      expect((await migrate()).warnings.join("\n")).toContain("invalid or unsupported");
      expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":2}');
    },
  );

  it.each([".doctor-importing", ".native-importing"])(
    "imports matching retained %s claims once",
    async (suffix) => {
      const original = fs.readFileSync(sourcePath);
      const claimPath = `${sourcePath}${suffix}`;
      fs.writeFileSync(claimPath, original);
      expect((await migrate()).changes).toEqual(["Migrated 1 device-auth token to SQLite."]);
      expect(readToken()?.token).toBe("legacy-token");
      expect((await migrate()).changes).toEqual([]);
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(fs.readFileSync(claimPath)).toEqual(original);
    },
  );

  it.each([".doctor-importing", ".native-importing"])(
    "rejects conflicting %s claims without importing tokens",
    async (suffix) => {
      const original = fs.readFileSync(sourcePath);
      const claimPath = `${sourcePath}${suffix}`;
      const conflict = Buffer.from(
        original.toString("utf8").replace("legacy-token", "other-token"),
      );
      fs.writeFileSync(claimPath, conflict);
      const result = await migrate();
      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toContain("Legacy device-auth files disagree");
      expect(
        withClientCredentialStore(env, false, (db) =>
          executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<ClientCredentialDatabase>(db)
              .selectFrom("device_auth_tokens")
              .select("token"),
          ),
        ),
      ).toBeUndefined();
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(fs.readFileSync(claimPath)).toEqual(conflict);
    },
  );

  it("imports all supported auth profiles in one migration", async () => {
    const retained = profiles.map(([profile, filename]) => {
      const pathname = path.join(stateDir, "identity", filename);
      const raw = JSON.stringify({
        version: 1,
        deviceId: `device-${profile}`,
        tokens: { node: { token: `token-${profile}`, scopes: [], updatedAtMs: 12 } },
      });
      fs.writeFileSync(pathname, raw);
      return { profile, pathname, raw };
    });
    expect((await migrate()).warnings).toEqual([]);
    for (const { profile, pathname, raw } of retained) {
      expect(
        readDeviceAuthTokenForTest({ deviceId: `device-${profile}`, role: "node", env })?.token,
      ).toBe(`token-${profile}`);
      expect(fs.readFileSync(pathname, "utf8")).toBe(raw);
    }
  });

  it.each(profiles)(
    "does not reimport revoked %s auth when retained JSON is edited",
    async (_profile, filename) => {
      selectSource(filename);
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
    },
  );
});
