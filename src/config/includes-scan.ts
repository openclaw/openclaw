import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  createConfigIncludeResolutionSession,
  INCLUDE_KEY,
  MAX_INCLUDE_DEPTH,
  readConfigIncludeFileWithGuards,
  type IncludeResolver,
} from "./includes.js";
import { resolveIncludeRoots } from "./paths.js";
import { visitConfigValueTree } from "./value-tree.js";

// Include discovery walks nested config objects because include blocks may be embedded.
function listDirectIncludes(parsed: unknown): string[] {
  const out: string[] = [];
  visitConfigValueTree(parsed, (value) => {
    const includeVal = isRecord(value) ? value[INCLUDE_KEY] : undefined;
    if (typeof includeVal === "string") {
      out.push(includeVal);
    } else if (Array.isArray(includeVal)) {
      for (const item of includeVal) {
        if (typeof item === "string") {
          out.push(item);
        }
      }
    }
    return true;
  });
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
  // Canonical paths dedupe permission targets; lexical bases preserve relative
  // include contexts and may need revisiting when first reached too deeply.
  const walkedDepthByBase = new Map<string, number>();
  const allowedRoots = params.allowedRoots ?? resolveIncludeRoots(params.env);
  const resolveInclude = createConfigIncludeResolutionSession(params.configPath, allowedRoots);

  const walk = (basePath: string, parsed: unknown, depth: number): void => {
    if (depth >= MAX_INCLUDE_DEPTH) {
      return;
    }
    for (const includePath of listDirectIncludes(parsed)) {
      let openedBasePath: string | undefined;
      let nestedInclude: { basePath: string; parsed: unknown } | undefined;
      const resolver: IncludeResolver = {
        readFile: (candidate) => fs.readFileSync(candidate, "utf-8"),
        readFileWithGuards: (readParams) => {
          return readConfigIncludeFileWithGuards({
            ...readParams,
            onResolvedPath: (resolvedIncludePath) => {
              includedPaths.add(resolvedIncludePath);
              const lexicalBasePath = path.normalize(readParams.resolvedPath);
              const nextDepth = depth + 1;
              const walkedDepth = walkedDepthByBase.get(lexicalBasePath);
              if (walkedDepth !== undefined && walkedDepth <= nextDepth) {
                return;
              }
              walkedDepthByBase.set(lexicalBasePath, nextDepth);
              openedBasePath = lexicalBasePath;
            },
          });
        },
        parseJson: (raw) => {
          const nestedParsed = parseJsonWithJson5Fallback(raw);
          if (openedBasePath) {
            nestedInclude = { basePath: openedBasePath, parsed: nestedParsed };
          }
          // The scanner owns nested traversal so one malformed sibling cannot
          // hide later guarded files. The production resolver still owns each
          // path, root, symlink, file-type, hardlink, and byte-limit decision.
          return {};
        },
      };

      try {
        resolveInclude({ [INCLUDE_KEY]: includePath }, basePath, resolver);
      } catch {
        // Invalid includes are reported by config validation. Permission repair
        // only retains files that reached the production guarded-open boundary.
      }
      if (nestedInclude) {
        walk(nestedInclude.basePath, nestedInclude.parsed, depth + 1);
      }
    }
  };

  walk(params.configPath, params.parsed, 0);
  return [...includedPaths];
}
