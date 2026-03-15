import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_TYPE_FILE_BYTES = 512_000; // 512KB per type file
const MAX_TOTAL_TYPE_BYTES = 2_000_000; // 2MB total for all types

export type TypeDefinitionFile = {
  /** Relative path from workspace root */
  relativePath: string;
  /** Absolute path to the file */
  absolutePath: string;
  /** File content */
  content: string;
  /** File size in bytes */
  size: number;
};

export type TypeDefinitionsResult = {
  /** All type definition files found */
  files: TypeDefinitionFile[];
  /** Total size in bytes */
  totalSize: number;
  /** Directory where types were found (relative to workspace) */
  typesDir?: string;
  /** Whether types directory exists */
  exists: boolean;
};

/**
 * Detect and load type definitions from `src/types/` or `types/` directory.
 * Returns type definition files and metadata for inclusion in agent prompts.
 */
export async function loadTypeDefinitions(params: {
  workspaceDir: string;
  /** Maximum bytes per file (default: 512KB) */
  maxFileBytes?: number;
  /** Maximum total bytes across all files (default: 2MB) */
  maxTotalBytes?: number;
}): Promise<TypeDefinitionsResult> {
  const maxFileBytes = params.maxFileBytes ?? MAX_TYPE_FILE_BYTES;
  const maxTotalBytes = params.maxTotalBytes ?? MAX_TOTAL_TYPE_BYTES;

  // Try src/types first, then types
  const candidates = ["src/types", "types"];
  let typesDir: string | undefined;
  let typesDirPath: string | undefined;

  for (const candidate of candidates) {
    const candidatePath = path.join(params.workspaceDir, candidate);
    try {
      const stat = await fs.stat(candidatePath);
      if (stat.isDirectory()) {
        typesDir = candidate;
        typesDirPath = candidatePath;
        break;
      }
    } catch {
      // Try next candidate
      continue;
    }
  }

  if (!typesDir || !typesDirPath) {
    return {
      files: [],
      totalSize: 0,
      exists: false,
    };
  }

  // Scan directory for TypeScript files
  const files: TypeDefinitionFile[] = [];
  let totalSize = 0;

  const scanDir = async (dirPath: string, relativeBase: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = path.join(relativeBase, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories (only if we still have budget)
        if (totalSize < maxTotalBytes) {
          await scanDir(absolutePath, relativePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      // Only include .ts and .tsx files (this already covers .d.ts)
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
        continue;
      }

      // Skip test files
      if (
        entry.name.endsWith(".test.ts") ||
        entry.name.endsWith(".test.tsx") ||
        entry.name.endsWith(".spec.ts") ||
        entry.name.endsWith(".spec.tsx") ||
        entry.name.includes(".test.") ||
        entry.name.includes(".spec.")
      ) {
        continue;
      }

      // Check if we've exceeded total size limit
      if (totalSize >= maxTotalBytes) {
        break;
      }

      // Try to read the file
      try {
        const stat = await fs.stat(absolutePath);
        const fileSize = stat.size;

        // Check if we've exceeded total size limit or file is too large
        if (fileSize > maxFileBytes || totalSize + fileSize > maxTotalBytes) {
          continue;
        }

        const content = await fs.readFile(absolutePath, "utf-8");
        const size = Buffer.byteLength(content, "utf-8");

        files.push({
          relativePath,
          absolutePath,
          content,
          size,
        });

        totalSize += size;
      } catch {
        // Skip files that can't be read
        continue;
      }
    }
  };

  await scanDir(typesDirPath, typesDir);

  // Sort files: root index.ts first (barrel export), then alphabetically
  files.sort((a, b) => {
    // Only prioritize root-level index.ts, not nested ones
    const aIsIndex =
      a.relativePath === `${typesDir}/index.ts` || a.relativePath === `${typesDir}\\index.ts`;
    const bIsIndex =
      b.relativePath === `${typesDir}/index.ts` || b.relativePath === `${typesDir}\\index.ts`;

    if (aIsIndex && !bIsIndex) {
      return -1;
    }
    if (!aIsIndex && bIsIndex) {
      return 1;
    }

    return a.relativePath.localeCompare(b.relativePath);
  });

  return {
    files,
    totalSize,
    typesDir,
    exists: true,
  };
}

/**
 * Build type definitions prompt section for agent system prompts.
 * Returns formatted text to inject before project context files.
 */
export function buildTypeDefinitionsPrompt(result: TypeDefinitionsResult): string {
  if (!result.exists || result.files.length === 0) {
    return "";
  }

  const lines: string[] = [
    "# Type Definitions",
    "",
    "The following TypeScript type definitions exist in this repository.",
    "**CRITICAL:** Use ONLY the types defined below. Do NOT create new type names.",
    "If you need a type that doesn't exist, ask before creating it.",
    "",
  ];

  for (const file of result.files) {
    lines.push(`## ${file.relativePath}`, "", "```typescript", file.content.trim(), "```", "");
  }

  return lines.join("\n");
}
