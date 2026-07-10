// Scans included config files and resolves include graphs.
import fs from "node:fs";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  INCLUDE_KEY,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludes,
  type IncludeResolver,
} from "./includes.js";
import { resolveIncludeRoots } from "./paths.js";

// Include discovery walks nested config objects because include blocks may be embedded.
function listDirectIncludes(parsed: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    const rec = value as Record<string, unknown>;
    const includeVal = rec[INCLUDE_KEY];
    if (typeof includeVal === "string") {
      out.push(includeVal);
    } else if (Array.isArray(includeVal)) {
      for (const item of includeVal) {
        if (typeof item === "string") {
          out.push(item);
        }
      }
    }
    for (const v of Object.values(rec)) {
      visit(v);
    }
  };
  visit(parsed);
  return out;
}

/** Collects recursively referenced config include files without requiring a valid full config. */
export async function collectIncludePathsRecursive(params: {
  configPath: string;
  parsed: unknown;
  env?: NodeJS.ProcessEnv;
  allowedRoots?: readonly string[];
}): Promise<string[]> {
  const includedPaths = new Set<string>();
  const allowedRoots = params.allowedRoots ?? resolveIncludeRoots(params.env);
  const resolver: IncludeResolver = {
    readFile: (candidate) => fs.readFileSync(candidate, "utf-8"),
    readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
      readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath,
        rootRealDir,
        onResolvedPath: (resolvedIncludePath) => includedPaths.add(resolvedIncludePath),
      }),
    parseJson: parseJsonWithJson5Fallback,
  };

  for (const includePath of listDirectIncludes(params.parsed)) {
    try {
      // The resolver owns traversal, root containment, symlink validation, file
      // type checks, and byte limits. A malformed include must not prevent us
      // from auditing other independently referenced safe files.
      resolveConfigIncludes({ [INCLUDE_KEY]: includePath }, params.configPath, resolver, {
        allowedRoots,
      });
    } catch {
      // Security audits only act on files the production include resolver could
      // successfully open; invalid includes are handled by config validation.
    }
  }
  return [...includedPaths];
}
