import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../../../config/paths.js";
import { openBoundaryFile } from "../../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const MAX_SHARED_FILE_BYTES = 2 * 1024 * 1024;
const log = createSubsystemLogger("shared-bootstrap");

const sharedBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const sharedDir = path.join(STATE_DIR, "shared");

  let entries: string[];
  try {
    entries = await fs.readdir(sharedDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }

  const sharedFiles = entries
    .filter((f) => f.startsWith("SHARED_") && f.endsWith(".md"))
    .toSorted();
  if (sharedFiles.length === 0) {
    return;
  }

  for (const file of sharedFiles) {
    const filePath = path.join(sharedDir, file);
    const opened = await openBoundaryFile({
      absolutePath: filePath,
      rootPath: sharedDir,
      boundaryLabel: "shared bootstrap",
      maxBytes: MAX_SHARED_FILE_BYTES,
    });
    if (!opened.ok) {
      log.warn(`skipping ${file}: ${opened.reason}`);
      continue;
    }
    try {
      const content = syncFs.readFileSync(opened.fd, "utf-8");
      // Intentionally does NOT re-apply filterBootstrapFilesForSession so
      // shared files reach subagent and cron sessions unconditionally.
      event.context.bootstrapFiles.push({
        name: file,
        path: filePath,
        content,
        missing: false,
      });
    } finally {
      syncFs.closeSync(opened.fd);
    }
  }
};

export default sharedBootstrapHook;
