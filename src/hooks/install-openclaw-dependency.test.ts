import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";

const runCommandWithTimeoutMock = vi.fn();
const scanPackageInstallSourceMock = vi.fn();
const scanInstalledPackageDependencyTreeMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../plugins/install-security-scan.js", () => ({
  scanPackageInstallSource: (...args: unknown[]) => scanPackageInstallSourceMock(...args),
  scanInstalledPackageDependencyTree: (...args: unknown[]) =>
    scanInstalledPackageDependencyTreeMock(...args),
}));

vi.resetModules();

const { installHooksFromPath } = await import("./install.js");

describe("hook pack OpenClaw dependencies", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-hook-host-dependency-",
  });

  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    scanPackageInstallSourceMock.mockReset().mockResolvedValue(undefined);
    scanInstalledPackageDependencyTreeMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it.each(["install", "update"] as const)(
    "preserves the declared OpenClaw dependency during %s",
    async (mode) => {
      await fixtureRootTracker.setup();
      const root = await fixtureRootTracker.make(mode);
      const packageDir = path.join(root, "package");
      const hooksDir = path.join(root, "hooks");
      await fs.mkdir(path.join(packageDir, "hooks", "one-hook"), { recursive: true });
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@openclaw/test-hooks",
          version: "1.0.0",
          openclaw: { hooks: ["./hooks/one-hook"] },
          dependencies: { openclaw: ">=2026.4.5" },
        }),
      );
      await fs.writeFile(
        path.join(packageDir, "hooks", "one-hook", "HOOK.md"),
        [
          "---",
          "name: one-hook",
          "description: One hook",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
          "",
          "# One Hook",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(packageDir, "hooks", "one-hook", "handler.ts"),
        "export default async () => {};\n",
      );
      if (mode === "update") {
        await fs.mkdir(path.join(hooksDir, "test-hooks"), { recursive: true });
      }
      runCommandWithTimeoutMock.mockImplementation(async (_argv, optionsOrTimeout) => {
        const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
        if (!cwd) {
          throw new Error("expected staged hook install cwd");
        }
        const manifest = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
        expect(manifest.dependencies?.openclaw).toBe(">=2026.4.5");
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });

      const result = await installHooksFromPath({ path: packageDir, hooksDir, mode });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalled();
    },
  );
});
