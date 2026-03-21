import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectGlobalInstallManager, detectPackageManager } from "./detect-package-manager.js";

describe("detectPackageManager", () => {
  it("prefers packageManager from package.json when supported", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-pm-"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.8.1" }),
      "utf8",
    );
    await fs.writeFile(path.join(root, "package-lock.json"), "", "utf8");

    await expect(detectPackageManager(root)).resolves.toBe("pnpm");
  });

  it("falls back to lockfiles when package.json is missing or unsupported", async () => {
    const bunRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-pm-"));
    await fs.writeFile(path.join(bunRoot, "bun.lock"), "", "utf8");
    await expect(detectPackageManager(bunRoot)).resolves.toBe("bun");

    const legacyBunRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-pm-"));
    await fs.writeFile(path.join(legacyBunRoot, "bun.lockb"), "", "utf8");
    await expect(detectPackageManager(legacyBunRoot)).resolves.toBe("bun");

    const npmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-pm-"));
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.0.0" }),
      "utf8",
    );
    await fs.writeFile(path.join(npmRoot, "package-lock.json"), "", "utf8");
    await expect(detectPackageManager(npmRoot)).resolves.toBe("npm");
  });

  it("returns null when no package manager markers exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-pm-"));
    await fs.writeFile(path.join(root, "package.json"), "{not-json}", "utf8");

    await expect(detectPackageManager(root)).resolves.toBeNull();
  });
});

describe("detectGlobalInstallManager", () => {
  it("detects pnpm global install from .pnpm path", () => {
    expect(
      detectGlobalInstallManager(
        "/home/user/.local/share/pnpm/global/5/.pnpm/openclaw@2026.3.13/node_modules/openclaw",
      ),
    ).toBe("pnpm");
  });

  it("detects pnpm global install from pnpm/global path", () => {
    expect(
      detectGlobalInstallManager("/home/user/.local/share/pnpm/global/5/node_modules/openclaw"),
    ).toBe("pnpm");
  });

  it("detects bun global install from .bun path", () => {
    expect(detectGlobalInstallManager("/home/user/.bun/install/global/node_modules/openclaw")).toBe(
      "bun",
    );
  });

  it("detects npm global install (default) from Homebrew path", () => {
    expect(detectGlobalInstallManager("/opt/homebrew/lib/node_modules/openclaw")).toBe("npm");
  });

  it("detects npm global install from standard global path", () => {
    expect(detectGlobalInstallManager("/usr/lib/node_modules/openclaw")).toBe("npm");
  });

  it("detects npm global install from nvm path", () => {
    expect(
      detectGlobalInstallManager("/home/user/.nvm/versions/node/v22.0.0/lib/node_modules/openclaw"),
    ).toBe("npm");
  });
});
