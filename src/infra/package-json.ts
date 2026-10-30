import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { tryReadJson } from "./json-files.js";

// Installed metadata accepts a broader name grammar than registry install specs.
export function isPackageDependencyName(name: string): boolean {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    return (
      parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
    );
  }
  return (
    name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
  );
}

/** Reads package.json as a loose object, returning null for missing or invalid manifests. */
async function readPackageJson(root: string, options?: { maxBytes: number }) {
  return asNullableRecord(await tryReadJson<unknown>(path.join(root, "package.json"), options));
}

/** Reads and trims the package version string, returning null for blank or non-string values. */
export async function readPackageVersion(
  root: string,
  options?: { maxBytes: number },
): Promise<string | null> {
  return normalizeString((await readPackageJson(root, options))?.version);
}

/** Reads and trims the package name string, returning null for blank or non-string values. */
export async function readPackageName(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.name);
}

/** Reads and trims the packageManager spec, returning null for blank or non-string values. */
export async function readPackageManagerSpec(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.packageManager);
}
