// Bounded read of the global MCP registry for security audit.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_MCPORTER_REGISTRY_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_SIZE = 64 * 1024;

export async function readBoundedMcporterRegistry(stateDir: string): Promise<unknown> {
  const registryPath = path.join(stateDir, "skills", "config", "mcporter.json");
  let handle: fs.FileHandle | undefined;
  try {
    // Open without O_NOFOLLOW so valid symlinked registries are followed,
    // while still bounding the read to avoid audit OOM on oversized targets.
    handle = await fs.open(registryPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MCPORTER_REGISTRY_BYTES) {
      throw new Error("mcporter registry missing or oversized");
    }
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, MAX_MCPORTER_REGISTRY_BYTES + 1));
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_MCPORTER_REGISTRY_BYTES) {
        throw new Error("mcporter registry exceeds size limit");
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf-8"));
  } finally {
    await handle?.close();
  }
}
