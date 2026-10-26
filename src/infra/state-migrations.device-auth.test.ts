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
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
  prepareLegacyDeviceAuth,
} from "./state-migrations.device-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
const readStoredToken = () =>
  withClientCredentialStore(env, false, (db) =>
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<ClientCredentialDatabase>(db)
        .selectFrom("device_auth_tokens")
        .select("token"),
    ),
  );
const readSource = () => fs.readFileSync(sourcePath);
function writeClaim(suffix: string, token = "legacy-token") {
  const original = readSource();
  const claimPath = `${sourcePath}${suffix}`;
  const claim = Buffer.from(original.toString("utf8").replace("legacy-token", token));
  fs.writeFileSync(claimPath, claim);
  return { original, claimPath, claim };
}
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
  it.each([
    ...sourceVariants.map(([profile, filename]) => ({ profile, filename, canonical: false })),
    ...profiles.map(([profile, filename]) => ({ profile, filename, canonical: true })),
  ])(
    "imports $profile auth from $filename with Doctor authority, preserving canonical=$canonical",
    async ({ filename, canonical }) => {
      selectSource(filename);
      if (canonical) {
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
      }
      const original = readSource();
      expect(detectLegacyDeviceAuth({ stateDir })).toMatchObject({
        sourcePresent: true,
        hasLegacy: false,
      });
      expect(detectLegacyDeviceAuth({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
        true,
      );
      const result = await migrate();
      expect(result.warnings).toEqual([]);
      if (canonical) {
        expect(result.notices).toContain("Preserved 1 canonical SQLite device-auth token.");
        expect(readToken()?.token).toBe("canonical-token");
      } else {
        expect(result.changes).toEqual(["Migrated 1 device-auth token to SQLite."]);
        expect(readToken()).toEqual({
          token: "legacy-token",
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          updatedAtMs: 10,
        });
      }
      expect(readSource()).toEqual(original);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
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

  it("preserves malformed UTF-8 without consuming the source, then imports repaired Unicode", async () => {
    const original = readSource();
    const malformed = Buffer.from(original);
    malformed[malformed.indexOf("legacy-token")] = 0xff;
    fs.writeFileSync(sourcePath, malformed);

    await expect(prepareLegacyDeviceAuth({ stateDir, legacyImports: {} })).rejects.toThrow(
      `Legacy device-auth store ${sourcePath} must be valid UTF-8.`,
    );
    const refused = await migrate();
    expect(refused.changes).toEqual([]);
    expect(refused.warnings).toEqual([
      expect.stringContaining(`${sourcePath} must be valid UTF-8`),
    ]);
    expect(readStoredToken()).toBeUndefined();
    expect(readSource()).toEqual(malformed);

    fs.writeFileSync(sourcePath, original.toString("utf8").replace("legacy-token", "répaired-�"));
    expect((await migrate()).warnings).toEqual([]);
    expect(readToken()?.token).toBe("répaired-�");
  });

  it.each(
    [".doctor-importing", ".native-importing"].flatMap((suffix) =>
      ["legacy-token", "other-token"].map((token) => [suffix, token]),
    ),
  )(
    "retains %s claim bytes containing %s, importing only matching claims",
    async (suffix, token) => {
      const { original, claimPath, claim } = writeClaim(suffix, token);
      const result = await migrate();
      if (token === "legacy-token") {
        expect(result.changes).toEqual(["Migrated 1 device-auth token to SQLite."]);
        expect(readToken()?.token).toBe("legacy-token");
        expect((await migrate()).changes).toEqual([]);
      } else {
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toContain("Legacy device-auth files disagree");
        expect(readStoredToken()).toBeUndefined();
      }
      expect(readSource()).toEqual(original);
      expect(fs.readFileSync(claimPath)).toEqual(claim);
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
      const original = readSource();
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
