import fs from "node:fs";
import path from "node:path";

export type RestoreFile = { readonly live: string; readonly preimage: string | null };
export type RestoreManifest = {
  readonly v: 1;
  readonly runId: string;
  readonly files: readonly RestoreFile[];
};

export function invalidRestoreManifest(file: string, cause?: unknown): Error {
  return new Error(
    `Invalid update restore manifest ${file}. Preserve it and run openclaw triage before retrying the update.`,
    { cause },
  );
}

export function readRestoreManifest(file: string): RestoreManifest | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw invalidRestoreManifest(file, error);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("v" in value) ||
    value.v !== 1 ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !value.runId ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw invalidRestoreManifest(file);
  }
  const files: RestoreFile[] = [];
  const seen = new Set<string>();
  const entries: unknown[] = value.files;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("live" in entry) ||
      typeof entry.live !== "string" ||
      !path.isAbsolute(entry.live) ||
      seen.has(entry.live) ||
      !("preimage" in entry) ||
      (entry.preimage !== null &&
        (typeof entry.preimage !== "string" || !path.isAbsolute(entry.preimage)))
    ) {
      throw invalidRestoreManifest(file);
    }
    seen.add(entry.live);
    files.push({ live: entry.live, preimage: entry.preimage });
  }
  return { v: 1, runId: value.runId, files };
}
