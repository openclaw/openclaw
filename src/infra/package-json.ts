// Reads package.json metadata needed by install and update flows.
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { tryReadJson } from "./json-files.js";

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
