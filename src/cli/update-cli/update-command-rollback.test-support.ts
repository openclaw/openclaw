import fs from "node:fs";
import { expect } from "vitest";
import { setRuntimeConfigSnapshotRefreshHandler, writeConfigFile } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";

export async function writeWithRefreshFailure(
  nextConfig: OpenClawConfig,
  writeOptions: ConfigWriteOptions & { baseSnapshot: ConfigFileSnapshot },
  originalRaw: string,
): Promise<Error> {
  const configPath = writeOptions.baseSnapshot.path;
  let doctorError: Error | undefined;
  setRuntimeConfigSnapshotRefreshHandler({
    preflight: () => undefined,
    refresh: () => {
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
        meta: { migrations: { modelPolicyAllowlist: true } },
        wizard: { lastRunCommand: "doctor" },
      });
      throw new Error("Doctor runtime activation refused");
    },
  });
  try {
    await writeConfigFile(nextConfig, writeOptions);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    doctorError = error;
  } finally {
    setRuntimeConfigSnapshotRefreshHandler(null);
  }
  if (!doctorError) {
    throw new Error("Doctor config write completed without the expected refresh failure");
  }
  expect(doctorError).toMatchObject({
    name: "ConfigWritePostCommitError",
    configPath,
    rollbackStatus: "restored",
  });
  expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
  return doctorError;
}

export function expectDoctorRollback(
  activationConfig: UpdateConfigSnapshot | undefined,
  result: UpdateRunResult,
  configPath: string,
  originalRaw: string,
): void {
  expect(activationConfig).toMatchObject({
    path: configPath,
    raw: originalRaw,
    hash: hashConfigRaw(originalRaw),
    doctorOwned: true,
  });
  expect(result).toMatchObject({
    status: "error",
    recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
  });
}
