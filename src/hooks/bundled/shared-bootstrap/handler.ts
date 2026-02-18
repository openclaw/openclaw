import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import { STATE_DIR } from "../../../config/paths.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

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

  const sharedFiles = entries.filter((f) => f.startsWith("SHARED_") && f.endsWith(".md")).sort();
  if (sharedFiles.length === 0) {
    return;
  }

  for (const file of sharedFiles) {
    const filePath = path.join(sharedDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    // Cast needed: WorkspaceBootstrapFileName is a narrow union of known names,
    // but shared files use SHARED_* names by design.
    event.context.bootstrapFiles.push({
      name: file,
      path: filePath,
      content,
      missing: false,
    } as WorkspaceBootstrapFile);
  }
};

export default sharedBootstrapHook;
