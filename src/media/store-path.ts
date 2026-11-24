import path from "node:path";
import { resolveConfigDir } from "../infra/config-dir.js";

export function getMediaDir(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveConfigDir(env), "media");
}

// Saved media IDs are "<store UUID><ext>" or "<sanitized name>---<store UUID><ext>".
const SAVED_MEDIA_ID =
  /^(?:(.+)---)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(\.[^.]*)?$/iu;

/** Splits a saved media ID into the caller-facing name and extension around its store UUID. */
export function parseSavedMediaId(id: string): { name?: string; ext: string } | undefined {
  const match = SAVED_MEDIA_ID.exec(id);
  return match ? { ...(match[1] && { name: match[1] }), ext: match[2] ?? "" } : undefined;
}

/** A saved inbound file's identity without the store UUID each save mints. */
export function readSavedInboundMediaName(filePath: string, env?: NodeJS.ProcessEnv) {
  if (path.dirname(filePath) !== path.join(getMediaDir(env), "inbound")) {
    return undefined;
  }
  const id = parseSavedMediaId(path.basename(filePath));
  return id && `${id.name ?? ""}${id.ext}`;
}
