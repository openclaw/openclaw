import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  readDeviceAuthTokenForTest,
  seedDeviceAuthToken,
} from "./device-auth-store.test-support.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
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
  it("imports the last normalized role only with Doctor authority before deleting JSON", async () => {
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
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("preserves canonical SQLite rows instead of replaying stale JSON", async () => {
    seedDeviceAuthToken({ deviceId: "device-1", role: "operator", token: "canonical-token", env });
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    expect(result.notices).toContain("Preserved 1 canonical SQLite device-auth token.");
    expect(readToken()?.token).toBe("canonical-token");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("keeps invalid legacy state for operator repair", async () => {
    fs.writeFileSync(sourcePath, '{"version":2}');
    expect((await migrate()).warnings.join("\n")).toContain("invalid or unsupported");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
});
