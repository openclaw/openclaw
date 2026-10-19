import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const HELPER = path.resolve("scripts/e2e/lib/release-plugin-marketplace/lifecycle-assertions.mjs");
const tempDirs = new Set<string>();
let home: string;
let installPathFile: string;
const pluginId = "release-marketplace-plugin";

beforeEach(() => {
  home = makeTempDir(tempDirs, "openclaw-marketplace-lifecycle-");
  installPathFile = path.join(home, "install-path.txt");
});

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeIndex(record: Record<string, unknown> | null, packageVersion = "") {
  writePluginInstallIndexForE2E(
    {
      installRecords: record ? { [pluginId]: record } : {},
      plugins: record ? [{ pluginId, packageVersion }] : [],
    },
    { stateDir: path.join(home, ".openclaw") },
  );
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function runHelper(args: string[]) {
  const stateDir = path.join(home, ".openclaw");
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
  });
}

function writeMarketplaceState(version: string) {
  const stateDir = path.join(home, ".openclaw");
  const installPath = path.join(stateDir, "extensions", pluginId);
  fs.mkdirSync(installPath, { recursive: true });
  writeJson(path.join(installPath, "package.json"), { name: `@openclaw/${pluginId}`, version });
  writeJson(path.join(stateDir, "openclaw.json"), {
    plugins: { entries: { [pluginId]: { enabled: true } } },
  });
  writeIndex(
    {
      source: "marketplace",
      installPath,
      version,
      marketplaceName: "Release Fixture Marketplace",
      marketplaceSource: "release-fixtures",
      marketplacePlugin: pluginId,
    },
    version,
  );
  return installPath;
}

function assertMarketplace(version: string) {
  return runHelper([
    "assert-marketplace-state",
    pluginId,
    version,
    "release-fixtures",
    pluginId,
    installPathFile,
  ]);
}

function expectSuccess(result: ReturnType<typeof runHelper>) {
  expect(result).toMatchObject({ stderr: "", status: 0 });
}

describe("release plugin marketplace lifecycle assertions", () => {
  it("checks canonical marketplace metadata and stable managed install paths", () => {
    const installPath = writeMarketplaceState("0.0.1");
    expectSuccess(assertMarketplace("0.0.1"));
    expect(fs.readFileSync(installPathFile, "utf8").trim()).toBe(installPath);

    writeMarketplaceState("0.0.2");
    expectSuccess(assertMarketplace("0.0.2"));
  });

  it("rejects marketplace state with the wrong persisted version", () => {
    writeMarketplaceState("0.0.1");
    const result = assertMarketplace("0.0.2");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected install record version 0.0.2, got 0.0.1");
  });

  it("seeds uninstall state and verifies complete cleanup with sentinels preserved", () => {
    const installPath = writeMarketplaceState("0.0.2");
    const sentinelPluginId = "release-marketplace-other";
    const sentinelPath = path.join(home, "marketplace", sentinelPluginId);
    fs.mkdirSync(sentinelPath, { recursive: true });

    const seeded = runHelper([
      "seed-marketplace-uninstall-state",
      pluginId,
      sentinelPluginId,
      sentinelPath,
      installPathFile,
    ]);
    expectSuccess(seeded);

    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.plugins).toMatchObject({
      allow: [pluginId, sentinelPluginId],
      deny: [pluginId, sentinelPluginId],
      load: { paths: [installPath, sentinelPath] },
    });

    config.plugins.entries[pluginId] = { enabled: false };
    config.plugins.allow = [sentinelPluginId];
    config.plugins.deny = [sentinelPluginId];
    config.plugins.load.paths = [sentinelPath];
    writeJson(configPath, config);
    fs.rmSync(installPath, { recursive: true });
    writeIndex(null);

    const verified = runHelper([
      "assert-marketplace-uninstalled",
      pluginId,
      sentinelPluginId,
      sentinelPath,
      installPathFile,
    ]);
    expectSuccess(verified);
  });

  it("checks the exact dry-run and update outcome text", () => {
    const logPath = path.join(home, "update.log");
    fs.writeFileSync(logPath, "Would update release-marketplace-plugin: 0.0.1 -> 0.0.2.\n", "utf8");

    const result = runHelper([
      "assert-update-log",
      logPath,
      "Would update release-marketplace-plugin: 0.0.1 -> 0.0.2.",
    ]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
