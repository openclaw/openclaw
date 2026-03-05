import fs from "node:fs/promises";

export async function unlinkIfExists(filePath: string | null | undefined): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup for temp files.
  }
}
