// Media temp file helpers create and clean up temporary media files.
import fs from "node:fs/promises";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";

/** Best-effort temp-file cleanup helper for optional paths from media conversion flows. */
export async function unlinkIfExists(filePath: string | null | undefined): Promise<void> {
  if (!filePath) {
    return;
  }
  // A saved read artifact retains its creating file handle. Resolve that owned
  // resource before the ordinary conversion-temp cleanup path.
  const readScope = captureChannelReadScope();
  if (readScope) {
    await readScope.discardResource(filePath);
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup for temp files.
  }
}
