import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..");

/**
 * Files that are legitimately allowed to use console methods for CLI output,
 * error handling, or runtime infrastructure.
 */
const ALLOWED_CONSOLE_FILES = new Set([
  // CLI output and interactive prompts
  "src/cli/completion-cli.ts",
  "src/cli/program/help.ts",
  "src/acp/client.ts",
  "src/acp/server.ts",

  // Runtime infrastructure
  "src/runtime.ts",
  "src/globals.ts",

  // Entry points with top-level exception handlers
  "src/index.ts",
  "src/entry.ts",
  "src/cli/run-main.ts",
  "src/macos/relay.ts",
  "src/macos/gateway-daemon.ts",

  // Special cases that manage console state
  "src/logging/console.ts",
  "src/infra/unhandled-rejections.ts",

  // Test files (allowed to test console behavior)
  "src/logging/console-capture.test.ts",
  "src/logging/console-settings.test.ts",
  "src/logging/console-prefix.test.ts",
  "src/tui/theme/theme.test.ts",
  "src/line/markdown-to-line.test.ts",

  // Live test utilities
  "src/gateway/gateway-models.profiles.live.test.ts",
  "src/agents/models.profiles.live.test.ts",
]);

/**
 * Test that verifies we don't have raw console.log/warn/error/info/debug
 * outside of allowed files. This ensures the codebase uses structured logging.
 */
describe("console ban enforcement", () => {
  it("should not have raw console.log/warn/error/info in src/ outside allowed files", () => {
    const violations: string[] = [];

    function scanDirectory(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(path.resolve(__dirname, ".."), fullPath);

        if (entry.isDirectory()) {
          // Skip certain directories
          if (entry.name === "node_modules" || entry.name === ".git") {
            continue;
          }
          scanDirectory(fullPath);
          continue;
        }

        // Only check TypeScript source files (skip tests — they may legitimately use console)
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }

        // Skip allowed files
        const normalized = relativePath.replace(/\\/g, "/");
        if (ALLOWED_CONSOLE_FILES.has(`src/${normalized}`)) {
          continue;
        }

        // Read and check file content
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // Skip comments
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
            continue;
          }

          // Check for raw console usage
          const consoleMatch = /^\s*console\.(log|warn|error|info|debug)\s*\(/;
          if (consoleMatch.test(line)) {
            violations.push(`${normalized}:${i + 1}: ${trimmed.slice(0, 80)}`);
          }
        }
      }
    }

    scanDirectory(SRC_ROOT);

    if (violations.length > 0) {
      const message = [
        "Found raw console usage outside allowed files.",
        "Use structured logging instead:",
        "  - For subsystem logs: createSubsystemLogger('subsystem').info(msg)",
        "  - For general logs: getLogger().info(msg)",
        "  - For CLI output: keep console.log only in CLI files",
        "",
        "Violations:",
        ...violations.map((v) => `  ${v}`),
      ].join("\n");
      expect.fail(message);
    }
  });

  it("should use subsystem loggers for subsystem-prefixed messages", () => {
    // This test verifies that files with [subsystem] prefixes use createSubsystemLogger
    const violations: string[] = [];

    function scanDirectory(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(path.resolve(__dirname, ".."), fullPath);

        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") {
            continue;
          }
          scanDirectory(fullPath);
          continue;
        }

        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }

        const normalized = relativePath.replace(/\\/g, "/");
        if (ALLOWED_CONSOLE_FILES.has(`src/${normalized}`)) {
          continue;
        }

        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
            continue;
          }

          // Check for console.* with subsystem prefix pattern
          const subsystemPrefixMatch =
            /console\.(warn|error|log|info|debug)\s*\(\s*["`]\[[a-z][a-z0-9-]+\]/;
          if (subsystemPrefixMatch.test(line)) {
            violations.push(
              `${normalized}:${i + 1}: Should use createSubsystemLogger instead of console with prefix`,
            );
          }
        }
      }
    }

    scanDirectory(SRC_ROOT);

    if (violations.length > 0) {
      const message = [
        "Found console usage with subsystem prefixes.",
        "Replace with: const logger = createSubsystemLogger('subsystem'); logger.warn(msg);",
        "",
        "Violations:",
        ...violations.map((v) => `  ${v}`),
      ].join("\n");
      expect.fail(message);
    }
  });
});
