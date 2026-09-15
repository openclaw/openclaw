import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type DirectoryEntry = {
  name: string;
  isDirectory: boolean;
  /** True only for a regular file; absent/false preserves unsupported entry kinds. */
  isFile?: boolean;
};

/** Decode the sandbox directory command's metadata, never file contents. */
export function parseDirectoryEntries(text: string): DirectoryEntry[] {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) {
    throw new Error("Invalid sandbox directory listing.");
  }
  return entries.map((entry: unknown) => {
    const record = asNullableRecord(entry);
    if (!record || typeof record.name !== "string" || typeof record.isDirectory !== "boolean") {
      throw new Error("Invalid sandbox directory entry.");
    }
    // Absent isFile preserves unsupported entry kinds: a listing source may not
    // classify kinds, and consumers decline anything not explicitly a regular
    // file. Explicit non-boolean kinds are still invalid.
    const isFile = record.isFile ?? false;
    if (typeof isFile !== "boolean") {
      throw new Error("Invalid sandbox directory entry.");
    }
    return { name: record.name, isDirectory: record.isDirectory, isFile };
  });
}
