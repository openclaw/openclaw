import fs from "node:fs";
import path from "node:path";
import { resolvePackageExtensionEntries } from "../plugins/manifest.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { readPluginAuthoringJson as readJsonFile } from "./plugins-authoring-json.js";

export function resolveRootPath(input = process.cwd()): string {
  try {
    return fs.realpathSync.native(input);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      throwExpectedCliError(
        `Plugin root not found: ${input}. Set --root to an existing plugin project directory containing package.json, then retry.`,
      );
    }
    throw error;
  }
}

export function resolveEntryPath(
  rootDir: string,
  entry: string | undefined,
  suppliedRoot: string | undefined,
): string {
  if (entry) {
    if (path.isAbsolute(entry)) {
      const relative = path.relative(path.resolve(suppliedRoot ?? process.cwd()), entry);
      if (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        return path.resolve(rootDir, relative);
      }
    }
    return path.resolve(rootDir, entry);
  }
  const packagePath = path.join(rootDir, "package.json");
  if (fs.existsSync(packagePath)) {
    const extensionResolution = resolvePackageExtensionEntries(readJsonFile(packagePath));
    if (extensionResolution.status === "ok" && extensionResolution.entries[0]) {
      return path.resolve(rootDir, extensionResolution.entries[0]);
    }
  }
  return path.resolve(rootDir, "src/index.ts");
}
