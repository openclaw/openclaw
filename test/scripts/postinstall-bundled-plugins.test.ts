import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNestedNpmInstallEnv,
  runBundledPluginPostinstall,
} from "../../scripts/postinstall-bundled-plugins.mjs";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createExtensionsDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-postinstall-"));
  cleanupDirs.push(root);
  const extensionsDir = path.join(root, "dist", "extensions");
  await fs.mkdir(path.join(extensionsDir, "acpx"), { recursive: true });
  await fs.writeFile(path.join(extensionsDir, "acpx", "package.json"), "{}\n", "utf8");
  return extensionsDir;
}

describe("bundled plugin postinstall", () => {
  it("clears global npm config before nested installs", () => {
    expect(
      createNestedNpmInstallEnv({
        npm_config_global: "true",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      }),
    ).toEqual({
      HOME: "/tmp/home",
    });
  });

  it("installs bundled plugin deps only during global installs", async () => {
    const extensionsDir = await createExtensionsDir();
    const execSync = vi.fn();

    runBundledPluginPostinstall({
      env: { npm_config_global: "false" },
      extensionsDir,
      execSync,
    });

    expect(execSync).not.toHaveBeenCalled();
  });

  it("runs nested local installs with sanitized env when the sentinel package is missing", async () => {
    const extensionsDir = await createExtensionsDir();
    const execSync = vi.fn();

    runBundledPluginPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      execSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(execSync).toHaveBeenCalledWith("npm install --omit=dev --no-save --package-lock=false", {
      cwd: path.join(extensionsDir, "acpx"),
      env: {
        HOME: "/tmp/home",
      },
      stdio: "pipe",
    });
  });

  it("skips reinstall when the bundled sentinel package already exists", async () => {
    const extensionsDir = await createExtensionsDir();
    await fs.mkdir(path.join(extensionsDir, "acpx", "node_modules", "acpx"), { recursive: true });
    await fs.writeFile(
      path.join(extensionsDir, "acpx", "node_modules", "acpx", "package.json"),
      "{}\n",
      "utf8",
    );
    const execSync = vi.fn();

    runBundledPluginPostinstall({
      env: { npm_config_global: "true" },
      extensionsDir,
      execSync,
    });

    expect(execSync).not.toHaveBeenCalled();
  });
});
