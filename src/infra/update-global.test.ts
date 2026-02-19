import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectGlobalInstallManagerForRoot } from "./update-global.js";

describe("detectGlobalInstallManagerForRoot", () => {
  it("detects pnpm when pkgRoot is inside pnpm content-addressable store", async () => {
    // Simulate pnpm store layout:
    // pnpm root -g → /home/user/.local/share/pnpm/global/5/node_modules
    // pkgRoot      → /home/user/.local/share/pnpm/global/5/.pnpm/openclaw@2026.2.17/node_modules/openclaw
    const storeParent = path.join(os.tmpdir(), "pnpm-store-test-" + Date.now());
    const globalNodeModules = path.join(storeParent, "node_modules");
    const pkgRoot = path.join(
      storeParent,
      ".pnpm",
      "openclaw@2026.2.17_abc123",
      "node_modules",
      "openclaw",
    );

    const runCommand = async (argv: string[]) => {
      if (argv[0] === "npm") return { code: 1, stdout: "", stderr: "" };
      if (argv[0] === "pnpm" && argv[1] === "root") {
        return { code: 0, stdout: globalNodeModules + "\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const result = await detectGlobalInstallManagerForRoot(
      runCommand as Parameters<typeof detectGlobalInstallManagerForRoot>[0],
      pkgRoot,
      5000,
    );
    expect(result).toBe("pnpm");
  });

  it("returns null when pkgRoot is outside all known global stores", async () => {
    const runCommand = async () => ({ code: 1, stdout: "", stderr: "" });
    const result = await detectGlobalInstallManagerForRoot(
      runCommand as Parameters<typeof detectGlobalInstallManagerForRoot>[0],
      "/some/random/path/not/global",
      5000,
    );
    expect(result).toBeNull();
  });
});
