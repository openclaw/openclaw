// Bounded read of the global MCP registry for security audit.
import path from "node:path";
import { readRegularFile } from "../infra/regular-file.js";

const MAX_MCPORTER_REGISTRY_BYTES = 16 * 1024 * 1024;

export async function readBoundedMcporterRegistry(stateDir: string): Promise<unknown> {
  const registryPath = path.join(stateDir, "skills", "config", "mcporter.json");
  const { buffer } = await readRegularFile({
    filePath: registryPath,
    maxBytes: MAX_MCPORTER_REGISTRY_BYTES,
  });
  return JSON.parse(buffer.toString("utf-8"));
}
