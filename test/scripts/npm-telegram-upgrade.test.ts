import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scenario = "telegram-published-upgrade-bindings";
const published = "openclaw@2026.9.6";
const candidatePath = "/package-under-test/candidate.tgz";
function fixture() {
  const root = tempDirs.make("openclaw-telegram-upgrade-");
  const candidate = path.join(root, "candidate.tgz");
  writeFileSync(candidate, "package fixture");
  const run = (env: NodeJS.ProcessEnv, args = [DOCKER_SCRIPT_PATH]) =>
    spawnSync("bash", args, {
      encoding: "utf8",
      cwd: path.resolve(TEST_DIR, "../.."),
      env: {
        ...process.env,
        OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ: candidate,
        OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR: "",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
        OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: "mock-openai",
        OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: published,
        ...env,
      },
    });
  return { root, candidate, run };
}

describe("Telegram published upgrade Docker boundary", () => {
  it.each([false, true])("uses the published registry only for baseline install=%s", (baseline) => {
    const { root, run } = fixture();
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const start = script.indexOf('npm_install_timeout="');
    const install = script.slice(start, script.indexOf("\ncommand -v openclaw", start));
    writeFileSync(
      path.join(root, "npm"),
      '#!/bin/bash\nprintf "%s" "$NPM_CONFIG_REGISTRY" > "$REGISTRY_LOG"\n',
      { mode: 0o755 },
    );
    const result = run(
      {
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        REGISTRY_LOG: path.join(root, "registry.log"),
        OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "0",
        OPENCLAW_NPM_TELEGRAM_INSTALL_PUBLISHED_BASELINE: baseline ? "1" : "0",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "https://candidate.invalid",
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
        NPM_CONFIG_REGISTRY: "https://candidate.invalid",
      },
      [
        "-c",
        `set -euo pipefail\nsource scripts/e2e/lib/prepublish-plugin-registry.sh\ninstall_source=${published}\n${install}`,
      ],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(root, "registry.log"), "utf8")).toBe(
      baseline ? "https://registry.npmjs.org" : "https://candidate.invalid",
    );
  });

  it.each([
    [`${scenario},channel-canary`, published, "must run alone"],
    [`channel-canary,\n${scenario}`, published, "must run alone"],
    [scenario, "openclaw@latest", "exact published baseline"],
    [scenario, published, "deterministic mock-openai", "live-frontier"],
  ])(
    "rejects an invalid upgrade request before Docker: %s / %s",
    (scenarios, spec, message, providerMode = "mock-openai") => {
      const result = fixture().run({
        OPENCLAW_NPM_TELEGRAM_SCENARIOS: scenarios,
        OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: spec,
        OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: providerMode,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain("Docker");
    },
  );

  it.each([false, true])(
    "keeps the package and credential boundary for published upgrade=%s",
    (upgrade) => {
      const { root, candidate, run } = fixture();
      const callsPath = path.join(root, "docker.jsonl");
      writeFileSync(
        path.join(root, "docker"),
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'run' && args.includes('-i')) fs.readFileSync(0);
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify(args) + '\\n');
`,
        { mode: 0o755 },
      );
      const result = run({
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        DOCKER_CALLS: callsPath,
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
        OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO: "",
        OPENCLAW_NPM_TELEGRAM_SCENARIOS: upgrade ? scenario : "",
        OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: path.join(root, "output"),
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
        OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.invalid",
        OPENCLAW_QA_CONVEX_SECRET_CI: "synthetic-fixture-secret",
      });
      expect(result.status, result.stderr).toBe(0);
      const runs = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === "run");
      expect(runs).toHaveLength(2);
      const [install, runtime] = runs;
      assert(install && runtime);
      expect(install).toContain(
        `OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE=${upgrade ? published : candidatePath}`,
      );
      expect(install).toContain(
        `OPENCLAW_NPM_TELEGRAM_INSTALL_PUBLISHED_BASELINE=${upgrade ? "1" : "0"}`,
      );
      expect(install.some((arg) => arg.startsWith("OPENCLAW_QA_CONVEX_SECRET_"))).toBe(false);
      expect(runtime).toContain("OPENCLAW_QA_CONVEX_SECRET_CI");
      expect(runtime).toContain(
        `OPENCLAW_NPM_TELEGRAM_UPGRADE_CANDIDATE=${upgrade ? candidatePath : ""}`,
      );
      expect(runtime.includes(`${candidate}:${candidatePath}:ro`)).toBe(upgrade);
    },
  );
});
