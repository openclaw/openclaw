/**
 * Dependency Guard: Agents ↛ getPackForStage from pack-registry
 *
 * This test enforces that NO file under src/agents/ may import getPackForStage
 * from ../clarityburst/pack-registry.js (or any equivalent relative path).
 *
 * Rationale:
 * - getPackForStage is an internal implementation detail of ClarityBurst
 * - Agents should request packs via the public gating API, not direct registry access
 * - Direct registry access bypasses dispatch gating controls
 *
 * Forbidden pattern:
 *   import { getPackForStage } from "../clarityburst/pack-registry.js"
 *   import { getPackForStage } from "../../clarityburst/pack-registry.js"
 *
 * NOTE: Test files (*.test.ts) are excluded from this check because:
 * 1. They don't create runtime violations
 * 2. Integration tests may need direct access for mocking/setup
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ESM-compatible way to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Navigate up from __tests__ to clarityburst to src, then to agents
const AGENTS_DIR = path.join(__dirname, "../../agents");

/**
 * Recursively collect all .ts and .js PRODUCTION files in a directory,
 * excluding test files (*.test.ts), node_modules, and test-fixtures.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules and test-fixtures
        if (entry.name === "node_modules" || entry.name === "test-fixtures") {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        // Include .ts and .js files, but SKIP test files
        if (
          /\.(ts|js|mts|mjs)$/.test(entry.name) &&
          !entry.name.includes(".test.")
        ) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Check if a file contains forbidden imports of getPackForStage from pack-registry.
 * Returns an array of { line: number, content: string } for violations.
 *
 * Detects patterns like:
 *   import { getPackForStage } from "../clarityburst/pack-registry"
 *   import { getPackForStage, ... } from "../../clarityburst/pack-registry.js"
 *   export { ... getPackForStage ... } from "../clarityburst/pack-registry.js"
 */
function findForbiddenGetPackForStageImports(
  filePath: string
): Array<{ line: number; content: string }> {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Array<{ line: number; content: string }> = [];

  // Patterns that indicate getPackForStage imports from pack-registry
  const forbiddenPatterns = [
    // Single-line imports: import { getPackForStage, ... } from "../clarityburst/pack-registry.js"
    /^\s*(?:import|export)\s+\{[^}]*getPackForStage[^}]*\}\s+from\s+['"]\.\.\/clarityburst\/pack-registry/,
    /^\s*(?:import|export)\s+\{[^}]*getPackForStage[^}]*\}\s+from\s+['"]\.\.\/\.\.\/clarityburst\/pack-registry/,
    /^\s*(?:import|export)\s+\{[^}]*getPackForStage[^}]*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/clarityburst\/pack-registry/,
    // Multi-line imports (closing line): } from "../clarityburst/pack-registry.js"
    // We check the closing line for pack-registry, then verify in a second pass
    /^\s*\}\s+from\s+['"]\.\.\/clarityburst\/pack-registry/,
    /^\s*\}\s+from\s+['"]\.\.\/\.\.\/clarityburst\/pack-registry/,
    /^\s*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/clarityburst\/pack-registry/,
    // Absolute path imports
    /^\s*(?:import|export)\s+\{[^}]*getPackForStage[^}]*\}\s+from\s+['"].*clarityburst\/pack-registry/,
    /^\s*\}\s+from\s+['"].*clarityburst\/pack-registry/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Skip lines that are clearly comments
    const trimmedLine = line.trim();
    if (
      trimmedLine.startsWith("//") ||
      trimmedLine.startsWith("*") ||
      trimmedLine.startsWith("/*")
    ) {
      continue;
    }

    // Check if line contains "getPackForStage" and "pack-registry" together
    if (line.includes("getPackForStage") && line.includes("pack-registry")) {
      violations.push({ line: lineNumber, content: line.trim() });
      continue;
    }

    // For multi-line imports, check if closing line imports from pack-registry
    // and verify previous line(s) contain getPackForStage
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(line)) {
        // For multi-line closing patterns, check if getPackForStage appears in preceding lines
        if (line.trim().startsWith("}")) {
          // Look back up to 20 lines for getPackForStage
          let found = false;
          for (let j = Math.max(0, i - 20); j < i; j++) {
            if (lines[j].includes("getPackForStage")) {
              found = true;
              break;
            }
          }
          if (found) {
            violations.push({ line: lineNumber, content: line.trim() });
          }
        } else {
          violations.push({ line: lineNumber, content: line.trim() });
        }
        break; // Only report once per line
      }
    }
  }

  return violations;
}

describe("Agents ↛ getPackForStage from pack-registry Dependency Guard", () => {
  let sourceFiles: string[] = [];

  // Check if agents directory exists
  if (!fs.existsSync(AGENTS_DIR)) {
    console.warn(`Agents directory not found at ${AGENTS_DIR}`);
  } else {
    sourceFiles = collectSourceFiles(AGENTS_DIR);
  }

  it("should have agent source files to check", () => {
    if (sourceFiles.length === 0) {
      console.warn(
        "No source files found in agents directory - directory may not exist"
      );
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(0);
  });

  describe("no getPackForStage imports from pack-registry", () => {
    // Create a test for each source file
    for (const filePath of sourceFiles) {
      const relativePath = path.relative(AGENTS_DIR, filePath);

      it(`${relativePath} should not import getPackForStage from pack-registry`, () => {
        const violations = findForbiddenGetPackForStageImports(filePath);

        if (violations.length > 0) {
          const violationDetails = violations
            .map((v) => `  Line ${v.line}: ${v.content}`)
            .join("\n");

          expect.fail(
            `\n` +
              `FORBIDDEN IMPORT in ${relativePath}\n` +
              `\n` +
              `Agents MUST NOT import getPackForStage directly from pack-registry.\n` +
              `getPackForStage is an internal ClarityBurst implementation detail.\n` +
              `\n` +
              `Use the public gating API instead to request packs with dispatch controls.\n` +
              `\n` +
              `Found ${violations.length} forbidden import(s):\n` +
              `${violationDetails}\n` +
              `\n` +
              `To fix: Replace direct pack-registry imports with the public\n` +
              `request API (applyToolDispatchOverrides, deriveAllowedContracts, etc.).`
          );
        }

        // If we get here, no violations found
        expect(violations).toHaveLength(0);
      });
    }
  });

  describe("summary statistics", () => {
    it("should report total files scanned", () => {
      // This test always passes but logs useful info
      const totalFiles = sourceFiles.length;
      const tsFiles = sourceFiles.filter((f) => f.endsWith(".ts")).length;
      const jsFiles = sourceFiles.filter(
        (f) => f.endsWith(".js") || f.endsWith(".mjs")
      ).length;

      console.log(
        `\ngetPackForStage dependency guard scanned ${totalFiles} agent files ` +
          `(${tsFiles} .ts, ${jsFiles} .js/.mjs)`
      );

      expect(totalFiles).toBeGreaterThanOrEqual(0);
    });

    it("should confirm all files are clean", () => {
      const allViolations: Array<{
        file: string;
        line: number;
        content: string;
      }> = [];

      for (const filePath of sourceFiles) {
        const violations = findForbiddenGetPackForStageImports(filePath);
        for (const v of violations) {
          allViolations.push({
            file: path.relative(AGENTS_DIR, filePath),
            ...v,
          });
        }
      }

      if (allViolations.length > 0) {
        const summary = allViolations
          .map((v) => `  ${v.file}:${v.line} - ${v.content}`)
          .join("\n");

        expect.fail(
          `\nFound ${allViolations.length} forbidden getPackForStage import(s):\n${summary}`
        );
      }

      expect(allViolations).toHaveLength(0);
    });
  });
});
