// Scans included config files and resolves include graphs.
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { INCLUDE_KEY, INCLUDE_TEXT_KEY, MAX_INCLUDE_DEPTH } from "./includes.js";

// Include discovery walks nested config objects because include blocks may be embedded.
type DirectInclude = {
  path: string;
  /** Whether the include target may itself contain further includes. */
  recurse: boolean;
};

function listDirectIncludes(parsed: unknown): DirectInclude[] {
  const out: DirectInclude[] = [];
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
      out.push({ path: includeVal, recurse: true });
    } else if (Array.isArray(includeVal)) {
      for (const item of includeVal) {
        if (typeof item === "string") {
          out.push({ path: item, recurse: true });
        }
      }
    }
    // $includeText injects raw text and cannot contain further includes, so it
    // is watched as a dependency but never recursed into.
    const includeTextVal = rec[INCLUDE_TEXT_KEY];
    if (typeof includeTextVal === "string") {
      out.push({ path: includeTextVal, recurse: false });
    }
    for (const v of Object.values(rec)) {
      visit(v);
    }
  };
  visit(parsed);
  return out;
}

function resolveIncludePath(baseConfigPath: string, includePath: string): string {
  return path.normalize(
    path.isAbsolute(includePath)
      ? includePath
      : path.resolve(path.dirname(baseConfigPath), includePath),
  );
}

/** Collects recursively referenced config include files without requiring a valid full config. */
export async function collectIncludePathsRecursive(params: {
  configPath: string;
  parsed: unknown;
}): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];

  const walk = async (basePath: string, parsed: unknown, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) {
      return;
    }
    for (const { path: raw, recurse } of listDirectIncludes(parsed)) {
      const resolved = resolveIncludePath(basePath, raw);
      if (visited.has(resolved)) {
        continue;
      }
      visited.add(resolved);
      result.push(resolved);

      if (!recurse) {
        // Raw-text leaf: register as a watched dependency but do not parse or
        // descend into it.
        continue;
      }

      const rawText = await fs.readFile(resolved, "utf-8").catch(() => null);
      if (!rawText) {
        continue;
      }
      const nestedParsed = (() => {
        try {
          return parseJsonWithJson5Fallback(rawText);
        } catch {
          return null;
        }
      })();
      if (nestedParsed) {
        await walk(resolved, nestedParsed, depth + 1);
      }
    }
  };

  await walk(params.configPath, params.parsed, 0);
  return result;
}
