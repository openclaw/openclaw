import fs from "node:fs/promises";
import path from "node:path";
import { type DeviceBootstrapState } from "../../../infra/device-bootstrap.js";
import { resolvePairingPaths, writePairingStateRecord } from "../../../infra/pairing-files.js";

function resolveBootstrapPath(baseDir?: string): string {
  return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}

export async function legacyDeviceBootstrapFileExists(baseDir?: string): Promise<boolean> {
  return await fs
    .access(resolveBootstrapPath(baseDir))
    .then(() => true)
    .catch(() => false);
}

export async function importLegacyDeviceBootstrapFileToSqlite(baseDir?: string): Promise<{
  imported: boolean;
  tokens: number;
}> {
  const bootstrapPath = resolveBootstrapPath(baseDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(bootstrapPath, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, tokens: 0 };
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { imported: false, tokens: 0 };
  }
  writePairingStateRecord({
    baseDir,
    subdir: "devices",
    key: "bootstrap",
    value: parsed as DeviceBootstrapState,
  });
  await fs.rm(bootstrapPath, { force: true }).catch(() => undefined);
  return { imported: true, tokens: Object.keys(parsed).length };
}
