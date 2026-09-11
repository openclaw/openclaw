import fs from "node:fs/promises";

/** Classify snapshot inputs without opening SQLite or touching WAL companions. */
export async function isSqliteSnapshotFile(pathname: string): Promise<boolean> {
  if (pathname.endsWith(".sqlite")) {
    return true;
  }
  const handle = await fs.open(pathname, "r");
  try {
    const header = Buffer.alloc(16);
    const result = await handle.read(header, 0, 16, 0);
    return result.bytesRead === 16 && header.toString() === "SQLite format 3\0";
  } finally {
    await handle.close();
  }
}
