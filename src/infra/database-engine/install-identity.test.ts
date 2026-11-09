import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readOrCreateInstallationId } from "./install-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("creates the installation identity once and keeps it", () => {
  const stateDir = tempDirs.make("install-identity-");
  const id = readOrCreateInstallationId(stateDir);

  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(readOrCreateInstallationId(stateDir)).toBe(id);
  expect(fs.readdirSync(stateDir)).toEqual(["postgres-install.json"]);
  expect(fs.statSync(path.join(stateDir, "postgres-install.json")).mode & 0o777).toBe(0o600);
});

it("refuses a damaged installation identity instead of minting a new one", () => {
  const stateDir = tempDirs.make("install-identity-");
  fs.writeFileSync(path.join(stateDir, "postgres-install.json"), '{"installationId":"x"}\n');

  expect(() => readOrCreateInstallationId(stateDir)).toThrow(/restore it from backup/);
});
