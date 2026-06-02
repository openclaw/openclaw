import path from "node:path";
import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { tryReadJson } from "./json-files.js";

type PackageJson = {
  name?: unknown;
  packageManager?: unknown;
  version?: unknown;
};

/** Read package.json as a plain object, returning null for missing or non-object files. */
export async function readPackageJson(root: string): Promise<PackageJson | null> {
  const parsed = await tryReadJson<unknown>(path.join(root, "package.json"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as PackageJson)
    : null;
}

/** Read a normalized package version string from package.json. */
export async function readPackageVersion(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.version);
}

/** Read a normalized package name string from package.json. */
export async function readPackageName(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.name);
}

/** Read the raw packageManager spec, including any version suffix, from package.json. */
export async function readPackageManagerSpec(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.packageManager);
}
