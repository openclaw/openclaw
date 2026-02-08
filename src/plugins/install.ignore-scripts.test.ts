import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * VULN-210: Plugin installation must use --ignore-scripts flag
 *
 * This test verifies that npm install during plugin installation uses the
 * --ignore-scripts flag to prevent execution of arbitrary lifecycle scripts
 * from untrusted packages.
 *
 * CWE-506: Embedded Malicious Code
 * CWE-494: Download of Code Without Integrity Check
 */

// Capture all commands and options passed to runCommandWithTimeout
interface CapturedCommand {
  argv: string[];
  opts?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> };
}
const capturedCommands: CapturedCommand[] = [];

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(
    async (
      argv: string[],
      opts?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
    ) => {
      capturedCommands.push({ argv, opts });
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      };
    },
  ),
}));

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-plugin-scripts-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  capturedCommands.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("VULN-210: plugin install must use --ignore-scripts", () => {
  it("npm install includes --ignore-scripts flag", async () => {
    // Create a plugin package with dependencies
    const stateDir = makeTempDir();
    const pkgDir = makeTempDir();
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "test-plugin",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
        dependencies: {
          "some-dep": "1.0.0",
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "export {};", "utf-8");

    const extensionsDir = path.join(stateDir, "extensions");

    const { installPluginFromDir } = await import("./install.js");

    await installPluginFromDir({
      dirPath: pkgDir,
      extensionsDir,
    });

    // Find all npm install calls
    const npmInstallCalls = capturedCommands.filter(
      (cmd) => cmd.argv[0] === "npm" && cmd.argv[1] === "install",
    );

    // Should have exactly one npm install call
    expect(npmInstallCalls.length).toBe(1);

    const npmInstallCall = npmInstallCalls[0];

    // Must include --ignore-scripts flag
    expect(npmInstallCall.argv).toContain("--ignore-scripts");

    // Must run in the plugin target directory (security: ensures we install deps in isolated dir)
    expect(npmInstallCall.opts?.cwd).toBeDefined();
    expect(npmInstallCall.opts?.cwd).toContain("extensions");
  });
});
