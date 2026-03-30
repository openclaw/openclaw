import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VALID_BOOTSTRAP_NAMES, type WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "bootstrap-alternate-files";
const log = createSubsystemLogger("bootstrap-alternate-files");

/**
 * Expand a leading `~` to the user home directory.
 * Returns the original string unchanged if it does not start with `~`.
 */
function expandHomeTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Parse and validate the `files` config value.
 * Returns a map of bootstrap slot name → resolved absolute source path.
 * Entries with invalid slot names or non-string paths are logged and skipped.
 */
function resolveAlternateFileMap(
  hookConfig: Record<string, unknown>,
): Map<string, string> {
  const result = new Map<string, string>();
  const raw = hookConfig.files;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }
  for (const [slotName, sourcePath] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      log.warn(`skipping "${slotName}": source path must be a non-empty string`);
      continue;
    }
    if (!VALID_BOOTSTRAP_NAMES.has(slotName)) {
      log.warn(
        `skipping "${slotName}": not a recognized bootstrap basename (${[...VALID_BOOTSTRAP_NAMES].join(", ")})`,
      );
      continue;
    }
    const resolved = path.resolve(expandHomeTilde(sourcePath.trim()));
    result.set(slotName, resolved);
  }
  return result;
}

/**
 * Attempt to read a source file. Returns the content string on success, or null on any
 * read failure (missing file, permission error, cloud storage unavailability, etc.).
 */
async function tryReadSourceFile(sourcePath: string): Promise<string | null> {
  try {
    return await fs.readFile(sourcePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.warn(`source file not found: ${sourcePath}`);
    } else if (code === "EACCES" || code === "EPERM") {
      log.warn(`source file permission denied: ${sourcePath}`);
    } else if (code === "EAGAIN" || code === "EDEADLK") {
      // Cloud storage (Dropbox FileProvider) can return these transiently.
      log.warn(`source file temporarily unavailable (${code}): ${sourcePath}`);
    } else {
      log.warn(`failed to read source file ${sourcePath}: ${String(err)}`);
    }
    return null;
  }
}

const bootstrapAlternateFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const alternates = resolveAlternateFileMap(hookConfig as Record<string, unknown>);
  if (alternates.size === 0) {
    return;
  }

  const updated: WorkspaceBootstrapFile[] = [];
  for (const file of context.bootstrapFiles) {
    const sourcePath = alternates.get(file.name);
    if (!sourcePath) {
      // No alternate configured for this slot — keep as-is.
      updated.push(file);
      continue;
    }

    const content = await tryReadSourceFile(sourcePath);
    if (content === null) {
      // Read failed — leave the existing entry unchanged (may be missing: true).
      log.debug(`keeping existing entry for ${file.name} (source read failed)`);
      updated.push(file);
    } else {
      log.debug(`replaced ${file.name} from ${sourcePath}`);
      updated.push({
        name: file.name,
        path: sourcePath,
        content,
        missing: false,
      });
    }
  }

  context.bootstrapFiles = updated;

  // Warn for any configured alternate that found no matching slot.
  // This most commonly happens with MEMORY.md, which is only conditionally
  // added to bootstrapFiles when a local memory file actually exists.
  for (const slotName of alternates.keys()) {
    if (!updated.some((f) => f.name === slotName)) {
      log.warn(
        `configured alternate for "${slotName}" has no matching slot in bootstrap files — the slot was not loaded (no local file exists for this bootstrap name)`,
      );
    }
  }
};

export default bootstrapAlternateFilesHook;
