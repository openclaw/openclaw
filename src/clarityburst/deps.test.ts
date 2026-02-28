/**
 * Dependency Cycle Guard Test: ClarityBurst ↛ Agents
 *
 * This test enforces the architectural constraint that PRODUCTION modules in
 * src/clarityburst/ MUST NOT import from src/agents/. ClarityBurst is a
 * foundational layer that agents depend on, not the other way around.
 *
 * This prevents dependency cycles where:
 *   agents → clarityburst → agents (FORBIDDEN)
 *
 * The allowed dependency direction is:
 *   agents → clarityburst (OK)
 *   clarityburst → (other foundational modules) (OK)
 *
 * NOTE: Test files (*.test.ts) are excluded from this check because:
 * 1. They don't create runtime dependency cycles
 * 2. Integration tests often need to import from multiple layers
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ESM-compatible way to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLARITYBURST_DIR = __dirname;

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
        // Test files are allowed to import from agents for integration testing
        if (/\.(ts|js|mts|mjs)$/.test(entry.name) && !entry.name.includes(".test.")) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Check if a file contains forbidden imports from agents directory.
 * Returns an array of { line: number, content: string } for violations.
 *
 * Only detects actual import statements, not commented-out imports.
 * Also detects multi-line imports where `from "../agents/..."` is on a separate line.
 */
function findForbiddenImports(
  filePath: string
): Array<{ line: number; content: string }> {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Array<{ line: number; content: string }> = [];

  // Patterns that indicate imports from agents directory.
  // Note: These patterns are anchored to detect actual code, not comments.
  const forbiddenPatterns = [
    // Single-line imports: import ... from "../agents/..."
    /^\s*(?:import|export)\s+.*\s+from\s+['"]\.\.\/agents\//,
    /^\s*(?:import|export)\s+.*\s+from\s+['"]\.\.\/\.\.\/agents\//,
    /^\s*(?:import|export)\s+.*\s+from\s+['"]\.\.\/\.\.\/\.\.\/agents\//,
    // Multi-line imports: } from "../agents/..." (the closing line of a multi-line import)
    /^\s*\}\s*from\s+['"]\.\.\/agents\//,
    /^\s*\}\s*from\s+['"]\.\.\/\.\.\/agents\//,
    /^\s*\}\s*from\s+['"]\.\.\/\.\.\/\.\.\/agents\//,
    // Side-effect imports (anchored)
    /^\s*import\s+['"]\.\.\/agents\//,
    /^\s*import\s+['"]\.\.\/\.\.\/agents\//,
    // Dynamic imports (these could be mid-line, but must not be in a comment)
    /^\s*(?:await\s+)?import\s*\(\s*['"]\.\.\/agents\//,
    /^\s*(?:await\s+)?import\s*\(\s*['"]\.\.\/\.\.\/agents\//,
    // require() calls (anchored)
    /^\s*(?:const|let|var)\s+.*=\s*require\s*\(\s*['"]\.\.\/agents\//,
    /^\s*(?:const|let|var)\s+.*=\s*require\s*\(\s*['"]\.\.\/\.\.\/agents\//,
    /^\s*require\s*\(\s*['"]\.\.\/agents\//,
    /^\s*require\s*\(\s*['"]\.\.\/\.\.\/agents\//,
    // Absolute path imports (anchored)
    /^\s*(?:import|export)\s+.*\s+from\s+['"].*\/src\/agents\//,
    /^\s*\}\s*from\s+['"].*\/src\/agents\//,
    /^\s*import\s+['"].*\/src\/agents\//,
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

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(line)) {
        violations.push({ line: lineNumber, content: line.trim() });
        break; // Only report once per line
      }
    }
  }

  return violations;
}

describe("ClarityBurst → Agents Dependency Cycle Guard", () => {
  const sourceFiles = collectSourceFiles(CLARITYBURST_DIR);

  it("should have source files to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  describe("no imports from agents directory", () => {
    // Create a test for each source file
    for (const filePath of sourceFiles) {
      const relativePath = path.relative(CLARITYBURST_DIR, filePath);

      it(`${relativePath} should not import from agents/`, () => {
        const violations = findForbiddenImports(filePath);

        if (violations.length > 0) {
          const violationDetails = violations
            .map((v) => `  Line ${v.line}: ${v.content}`)
            .join("\n");

          expect.fail(
            `\n` +
              `DEPENDENCY CYCLE VIOLATION in ${relativePath}\n` +
              `\n` +
              `ClarityBurst modules MUST NOT import from agents/.\n` +
              `This would create a dependency cycle: agents → clarityburst → agents\n` +
              `\n` +
              `Found ${violations.length} forbidden import(s):\n` +
              `${violationDetails}\n` +
              `\n` +
              `To fix: Move shared code to a common module, or refactor to\n` +
              `avoid the circular dependency. ClarityBurst should remain\n` +
              `dependency-downward only.`
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
        `\nDependency cycle guard scanned ${totalFiles} files ` +
          `(${tsFiles} .ts, ${jsFiles} .js/.mjs)`
      );

      expect(totalFiles).toBeGreaterThan(0);
    });

    it("should confirm all files are clean", () => {
      const allViolations: Array<{ file: string; line: number; content: string }> = [];

      for (const filePath of sourceFiles) {
        const violations = findForbiddenImports(filePath);
        for (const v of violations) {
          allViolations.push({
            file: path.relative(CLARITYBURST_DIR, filePath),
            ...v,
          });
        }
      }

      if (allViolations.length > 0) {
        const summary = allViolations
          .map((v) => `  ${v.file}:${v.line} - ${v.content}`)
          .join("\n");

        expect.fail(
          `\nFound ${allViolations.length} dependency cycle violation(s):\n${summary}`
        );
      }

      expect(allViolations).toHaveLength(0);
    });
  });
});
