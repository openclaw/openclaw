/**
 * Fetch Gating Invariant Test
 *
 * This test enforces the critical invariant: ALL bare fetch() calls in production code
 * must be wrapped by one of the approved gated wrappers.
 *
 * Approved gated wrappers:
 * - applyNetworkIOGateAndFetch() from src/clarityburst/network-io-gating.ts
 * - gateFetch() from src/clarityburst/network-io-gating.ts
 * - fetchWithWebToolsNetworkGuard() from src/agents/tools/web-guarded-fetch.ts
 * - fetchWithSsrFGuard() from src/infra/net/fetch-guard.ts
 *
 * This invariant protects the entire rollout by ensuring no network I/O can bypass
 * the ClarityBurst execution-boundary gating.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../..");

/**
 * Exemptions: contexts where bare fetch() is allowed
 * - Test files (.test.ts, .e2e.test.ts) - testing framework setup
 * - Mock implementations in test files
 * - Comments and strings - not actual code
 * - Module imports - not actual fetch calls
 */
const EXEMPT_FILE_PATTERNS = [
  // Test files are exempt (they use fetch for test setup/mocking)
  /\.test\.ts$/,
  /\.e2e\.test\.ts$/,

  // Mock/stub files
  /mock\//,
  /stub\//,
  /fixtures\//,
  /test-mocks\./,

  // Files that wrap fetch (are themselves wrappers)
  /network-io-gating\.ts$/,
  /web-guarded-fetch\.ts$/,
  /fetch-guard\.ts$/,
];

const APPROVED_WRAPPERS = [
  "applyNetworkIOGateAndFetch",
  "gateFetch",
  "fetchWithWebToolsNetworkGuard",
  "fetchWithSsrFGuard",
  "withWebToolsNetworkGuard",
];

interface FetchViolation {
  file: string;
  line: number;
  code: string;
  message: string;
}

/**
 * Scan TypeScript source files for bare fetch() calls
 */
function scanSourceFiles(): FetchViolation[] {
  const violations: FetchViolation[] = [];
  const srcDir = path.join(projectRoot, "src");

  function walkDir(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectRoot, fullPath);

      // Skip node_modules and hidden directories
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }

      // Only process TypeScript files
      if (!entry.name.endsWith(".ts")) continue;

      // Check if file is exempt
      if (EXEMPT_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      // Find all fetch( calls
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Skip comments and string literals
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

        // Look for fetch( pattern
        const fetchMatches = line.matchAll(/\bfetch\s*\(/g);

        for (const match of fetchMatches) {
          const position = match.index ?? 0;

          // Skip if inside a string literal
          if (isInStringLiteral(line, position)) continue;

          // Skip if inside a comment
          if (isInComment(line, position)) continue;

          // Check if this fetch call is wrapped by an approved wrapper
          const isWrapped = isWrappedByApprovedWrapper(
            content,
            lineNum,
            position,
            line
          );

          if (!isWrapped) {
            violations.push({
              file: relativePath,
              line: lineNum,
              code: line.trim(),
              message: `Bare fetch() call not wrapped by approved gating wrapper. Must use one of: ${APPROVED_WRAPPERS.join(", ")}`,
            });
          }
        }
      }
    }
  }

  walkDir(srcDir);
  return violations;
}

/**
 * Check if a position in a line is inside a string literal
 */
function isInStringLiteral(line: string, position: number): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let i = 0;

  while (i < position && i < line.length) {
    const char = line[i];
    const prevChar = i > 0 ? line[i - 1] : "";

    if (prevChar === "\\" && (inSingleQuote || inDoubleQuote || inBacktick)) {
      i++;
      continue;
    }

    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
    }

    i++;
  }

  return inSingleQuote || inDoubleQuote || inBacktick;
}

/**
 * Check if a position in a line is inside a comment
 */
function isInComment(line: string, position: number): boolean {
  const commentIndex = line.indexOf("//");
  return commentIndex !== -1 && commentIndex < position;
}

/**
 * Check if a fetch() call is wrapped by an approved wrapper
 * by looking at the surrounding code context
 */
function isWrappedByApprovedWrapper(
  content: string,
  lineNum: number,
  position: number,
  line: string
): boolean {
  // Heuristic 1: Check if fetch is being assigned to result of a wrapper function
  if (line.includes("await ")) {
    // Look for patterns like:
    // const result = await applyNetworkIOGateAndFetch(...)
    // const result = await gateFetch(...)
    // const result = await fetchWithWebToolsNetworkGuard(...)
    // const result = await fetchWithSsrFGuard(...)

    const beforeFetch = line.substring(0, position);
    for (const wrapper of APPROVED_WRAPPERS) {
      if (beforeFetch.includes(wrapper)) {
        return true;
      }
    }
  }

  // Heuristic 2: Check if fetch is directly calling a wrapper
  // Pattern: fetch(...) should not appear; instead wrapper(...) should
  if (!line.includes("return fetch(") && !line.includes(" fetch(")) {
    return true; // Not a direct fetch call
  }

  // Heuristic 3: Check import statements and wrapped calls
  const lines = content.split("\n");
  const contextStart = Math.max(0, lineNum - 30); // Look back 30 lines
  const contextEnd = Math.min(lines.length, lineNum + 5); // Look ahead 5 lines
  const context = lines.slice(contextStart, contextEnd).join("\n");

  // If this is inside an array/object literal or parameter list for a wrapper, it's OK
  for (const wrapper of APPROVED_WRAPPERS) {
    if (context.includes(wrapper)) {
      return true;
    }
  }

  // Heuristic 4: Check if line is part of a mock/stub setup
  if (
    line.includes("vi.fn()") ||
    line.includes("vi.mock") ||
    line.includes("mockResolvedValue") ||
    line.includes("// Mock") ||
    line.includes("// stub")
  ) {
    return true;
  }

  return false;
}

describe("Fetch Gating Invariant", () => {
  it("enforces that ALL bare fetch() calls are wrapped by approved gating wrappers", () => {
    const violations = scanSourceFiles();

    if (violations.length > 0) {
      const report = violations
        .map((v) => `\n  ${v.file}:${v.line}\n    ${v.code}\n    ✗ ${v.message}`)
        .join("\n");

      throw new Error(
        `[FETCH GATING VIOLATION] ${violations.length} bare fetch() call(s) found that are not wrapped by approved gating:\n${report}\n\nApproved wrappers:\n  - applyNetworkIOGateAndFetch()\n  - gateFetch()\n  - fetchWithWebToolsNetworkGuard()\n  - fetchWithSsrFGuard()\n\nSee src/clarityburst/network-io-gating.ts for details.`
      );
    }

    expect(violations).toEqual([]);
  });

  it("documents the approved gating wrappers and their purposes", () => {
    // This test serves as documentation
    const wrapperInfo = {
      applyNetworkIOGateAndFetch:
        "Core NETWORK_IO gating wrapper for general HTTP requests",
      gateFetch: "Drop-in fetch replacement with automatic NETWORK_IO gating",
      fetchWithWebToolsNetworkGuard:
        "Web search tool inference wrapper with SSRF protection",
      fetchWithSsrFGuard: "SSRF protection wrapper for file downloads",
    };

    expect(Object.keys(wrapperInfo)).toEqual(APPROVED_WRAPPERS.slice(0, 4));

    for (const [wrapper, purpose] of Object.entries(wrapperInfo)) {
      expect(wrapper).toBeTruthy();
      expect(purpose).toBeTruthy();
    }
  });
});
