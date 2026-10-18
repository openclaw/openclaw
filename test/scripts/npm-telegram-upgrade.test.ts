import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Telegram published upgrade Docker boundary", () => {
  it.each([false, true])("uses the published registry only for baseline install=%s", (baseline) => {
    const root = tempDirs.make("openclaw-telegram-upgrade-registry-");
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const start = script.indexOf('npm_install_timeout="');
    const install = script.slice(start, script.indexOf("\ncommand -v openclaw", start));
    writeFileSync(
      path.join(root, "npm"),
      '#!/bin/bash\nprintf "%s" "$NPM_CONFIG_REGISTRY" > "$REGISTRY_LOG"\n',
      { mode: 0o755 },
    );
    const repo = path.resolve(TEST_DIR, "../..");
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\nsource scripts/e2e/lib/prepublish-plugin-registry.sh\ninstall_source=openclaw@2026.9.6\n${install}`,
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
          REGISTRY_LOG: path.join(root, "registry.log"),
          OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "0",
          OPENCLAW_NPM_TELEGRAM_INSTALL_PUBLISHED_BASELINE: baseline ? "1" : "0",
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "https://candidate.invalid",
          OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
          NPM_CONFIG_REGISTRY: "https://candidate.invalid",
        },
      },
    );
    expect(readFileSync(path.join(root, "registry.log"), "utf8")).toBe(
      baseline ? "https://registry.npmjs.org" : "https://candidate.invalid",
    );
  });

  it.each([
    ["telegram-published-upgrade-bindings,channel-canary", "openclaw@2026.9.6", "must run alone"],
    ["channel-canary,\ntelegram-published-upgrade-bindings", "openclaw@2026.9.6", "must run alone"],
    ["telegram-published-upgrade-bindings", "openclaw@latest", "exact published baseline"],
    [
      "telegram-published-upgrade-bindings",
      "openclaw@2026.9.6",
      "deterministic mock-openai",
      "live-frontier",
    ],
  ])(
    "rejects an invalid upgrade request before Docker: %s / %s",
    (scenarios, spec, message, providerMode = "mock-openai") => {
      const root = tempDirs.make("openclaw-telegram-upgrade-boundary-");
      const candidate = path.join(root, "candidate.tgz");
      writeFileSync(candidate, "package fixture");
      const result = spawnSync("bash", [DOCKER_SCRIPT_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_NPM_TELEGRAM_SCENARIOS: scenarios,
          OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: spec,
          OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: providerMode,
          OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ: candidate,
          OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR: "",
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain("Docker");
    },
  );

  it.each([false, true])(
    "keeps the package and credential boundary for published upgrade=%s",
    (upgrade) => {
      const root = tempDirs.make("openclaw-telegram-upgrade-boundary-");
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const callsPath = path.join(root, "docker.jsonl");
      const candidate = path.join(root, "candidate.tgz");
      writeFileSync(candidate, "package fixture");
      writeFileSync(
        path.join(bin, "docker"),
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[0] === 'run' && args.includes('-i') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify({ args, input }) + '\\n');
`,
        { mode: 0o755 },
      );
      execFileSync("bash", [DOCKER_SCRIPT_PATH], {
        cwd: path.resolve(TEST_DIR, "../.."),
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          DOCKER_CALLS: callsPath,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ: candidate,
          OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR: "",
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
          OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO: "",
          OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: "openclaw@2026.9.6",
          OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: "mock-openai",
          OPENCLAW_NPM_TELEGRAM_SCENARIOS: upgrade ? "telegram-published-upgrade-bindings" : "",
          OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: path.join(root, "output"),
          OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
          OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
          OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.invalid",
          OPENCLAW_QA_CONVEX_SECRET_CI: "synthetic-fixture-secret",
        },
      });
      const runs = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; input: string })
        .filter((call) => call.args[0] === "run");
      expect(runs).toHaveLength(2);
      const [install, runtime] = runs;
      assert(install && runtime);
      expect(install.args).toContain(
        `OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE=${upgrade ? "openclaw@2026.9.6" : "/package-under-test/candidate.tgz"}`,
      );
      expect(install.args).toContain(
        `OPENCLAW_NPM_TELEGRAM_INSTALL_PUBLISHED_BASELINE=${upgrade ? "1" : "0"}`,
      );
      expect(install.args.some((arg) => arg.startsWith("OPENCLAW_QA_CONVEX_SECRET_"))).toBe(false);
      expect(runtime.args).toContain("OPENCLAW_QA_CONVEX_SECRET_CI");
      expect(runtime.args).toContain(
        `OPENCLAW_NPM_TELEGRAM_UPGRADE_CANDIDATE=${upgrade ? "/package-under-test/candidate.tgz" : ""}`,
      );
      expect(runtime.args.includes(`${candidate}:/package-under-test/candidate.tgz:ro`)).toBe(
        upgrade,
      );
    },
  );
});
