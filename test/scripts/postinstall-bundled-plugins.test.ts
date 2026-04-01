import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNestedNpmInstallEnv,
  discoverBundledPluginRuntimeDeps,
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
  await fs.mkdir(extensionsDir, { recursive: true });
  return extensionsDir;
}

async function writePluginPackage(
  extensionsDir: string,
  pluginId: string,
  packageJson: Record<string, unknown>,
) {
  const pluginDir = path.join(extensionsDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
}

describe("bundled plugin postinstall", () => {
  function createBareNpmRunner(args: string[]) {
    return {
      command: "npm",
      args,
      env: {
        HOME: "/tmp/home",
        PATH: "/tmp/node/bin",
      },
      shell: false as const,
    };
  }

  it("clears global npm config before nested installs", () => {
    expect(
      createNestedNpmInstallEnv({
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      }),
    ).toEqual({
      HOME: "/tmp/home",
    });
  });

  it("installs bundled plugin deps only during global installs", async () => {
    const extensionsDir = await createExtensionsDir();
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.4.0",
      },
    });
    const spawnSync = vi.fn();

    runBundledPluginPostinstall({
      env: { npm_config_global: "false" },
      extensionsDir,
      spawnSync,
    });

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("runs nested local installs with sanitized env when the sentinel package is missing", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.4.0",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner([
        "install",
        "--omit=dev",
        "--no-save",
        "--package-lock=false",
        "acpx@0.4.0",
      ]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "acpx@0.4.0"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "acpx"),
        encoding: "utf8",
        env: {
          HOME: "/tmp/home",
          PATH: "/tmp/node/bin",
        },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
  });

  it("skips reinstall when the bundled sentinel package already exists", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.4.0",
      },
    });
    await fs.mkdir(path.join(packageRoot, "dist", "extensions", "acpx", "node_modules", "acpx"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(packageRoot, "dist", "extensions", "acpx", "node_modules", "acpx", "package.json"),
      "{}\n",
      "utf8",
    );
    const spawnSync = vi.fn();

    runBundledPluginPostinstall({
      env: { npm_config_global: "true" },
      extensionsDir,
      packageRoot,
      spawnSync,
    });

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("discovers bundled plugin runtime deps from extension manifests", async () => {
    const extensionsDir = await createExtensionsDir();
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "@slack/web-api": "7.11.0",
      },
    });
    await writePluginPackage(extensionsDir, "amazon-bedrock", {
      dependencies: {
        "@aws-sdk/client-bedrock": "3.1020.0",
      },
    });

    expect(discoverBundledPluginRuntimeDeps({ extensionsDir })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@slack/web-api",
          pluginIds: ["slack"],
          sentinelPath: path.join(
            "dist",
            "extensions",
            "slack",
            "node_modules",
            "@slack",
            "web-api",
            "package.json",
          ),
          version: "7.11.0",
        }),
        expect.objectContaining({
          name: "@aws-sdk/client-bedrock",
          pluginIds: ["amazon-bedrock"],
          sentinelPath: path.join(
            "dist",
            "extensions",
            "amazon-bedrock",
            "node_modules",
            "@aws-sdk",
            "client-bedrock",
            "package.json",
          ),
          version: "3.1020.0",
        }),
      ]),
    );
  });

  it("merges duplicate bundled runtime deps across plugins", async () => {
    const extensionsDir = await createExtensionsDir();
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "https-proxy-agent": "^8.0.0",
      },
    });
    await writePluginPackage(extensionsDir, "feishu", {
      dependencies: {
        "https-proxy-agent": "^8.0.0",
      },
    });

    expect(discoverBundledPluginRuntimeDeps({ extensionsDir })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "https-proxy-agent",
          pluginIds: ["feishu", "slack"],
          sentinelPath: path.join(
            "dist",
            "extensions",
            "feishu",
            "node_modules",
            "https-proxy-agent",
            "package.json",
          ),
          version: "^8.0.0",
        }),
      ]),
    );
  });

  it("installs missing bundled plugin runtime deps during global installs", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "@slack/web-api": "7.11.0",
      },
    });
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "@slack/web-api@7.11.0"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "slack"),
        encoding: "utf8",
        env: {
          HOME: "/tmp/home",
          PATH: expect.any(String),
        },
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "grammy@1.38.4"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "telegram"),
        encoding: "utf8",
        env: {
          HOME: "/tmp/home",
          PATH: expect.any(String),
        },
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
  });

  it("installs only missing bundled plugin runtime deps", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "@slack/web-api": "7.11.0",
      },
    });
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    await fs.mkdir(
      path.join(packageRoot, "dist", "extensions", "slack", "node_modules", "@slack", "web-api"),
      {
        recursive: true,
      },
    );
    await fs.writeFile(
      path.join(
        packageRoot,
        "dist",
        "extensions",
        "slack",
        "node_modules",
        "@slack",
        "web-api",
        "package.json",
      ),
      "{}\n",
    );
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "grammy@1.38.4"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "telegram"),
        encoding: "utf8",
        env: {
          HOME: "/tmp/home",
          PATH: expect.any(String),
        },
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
  });

  it("installs bundled plugin deps when npm location is global", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner([
        "install",
        "--omit=dev",
        "--no-save",
        "--package-lock=false",
        "grammy@1.38.4",
      ]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "grammy@1.38.4"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "telegram"),
        encoding: "utf8",
        env: {
          HOME: "/tmp/home",
          PATH: "/tmp/node/bin",
        },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
  });

  it("installs shared runtime deps separately for each plugin directory when needed", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "discord", {
      dependencies: {
        "https-proxy-agent": "7.0.6",
      },
    });
    await writePluginPackage(extensionsDir, "feishu", {
      dependencies: {
        "https-proxy-agent": "7.0.6",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: { npm_config_global: "true", HOME: "/tmp/home" },
      extensionsDir,
      packageRoot,
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "https-proxy-agent@7.0.6"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "discord"),
        encoding: "utf8",
        env: expect.objectContaining({ HOME: "/tmp/home" }),
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "https-proxy-agent@7.0.6"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "feishu"),
        encoding: "utf8",
        env: expect.objectContaining({ HOME: "/tmp/home" }),
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
  });

  it("keeps same package name with different versions as separate plugin installs", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "discord", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.39.0",
      },
    });

    expect(discoverBundledPluginRuntimeDeps({ extensionsDir })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "grammy",
          version: "1.38.4",
          pluginIds: ["discord"],
          sentinelPath: path.join(
            "dist",
            "extensions",
            "discord",
            "node_modules",
            "grammy",
            "package.json",
          ),
        }),
        expect.objectContaining({
          name: "grammy",
          version: "1.39.0",
          pluginIds: ["telegram"],
          sentinelPath: path.join(
            "dist",
            "extensions",
            "telegram",
            "node_modules",
            "grammy",
            "package.json",
          ),
        }),
      ]),
    );

    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));
    runBundledPluginPostinstall({
      env: { npm_config_global: "true", HOME: "/tmp/home" },
      extensionsDir,
      packageRoot,
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "grammy@1.38.4"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "discord"),
        encoding: "utf8",
        env: expect.objectContaining({ HOME: "/tmp/home" }),
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["install", "--omit=dev", "--no-save", "--package-lock=false", "grammy@1.39.0"],
      {
        cwd: path.join(packageRoot, "dist", "extensions", "telegram"),
        encoding: "utf8",
        env: expect.objectContaining({ HOME: "/tmp/home" }),
        shell: expect.anything(),
        stdio: "pipe",
        windowsVerbatimArguments: expect.anything(),
      },
    );
  });
});
