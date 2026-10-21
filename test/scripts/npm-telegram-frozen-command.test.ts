import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scenarioPath = "qa/scenarios/channels/telegram-repeated-command-authorization.yaml";
const trusted = readFileSync(path.join(repoRoot, scenarioPath), "utf8");
const silent = "              - waitForNoOutbound:\n                  quietMs: 3000\n";
const explicit =
  "              - waitForOutbound:\n" +
  "                  conversation: { id: telegram-command-room, kind: channel }\n" +
  "                  textIncludes: You are not authorized to use this command.\n" +
  "                  timeoutMs: 60000\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const read = (file: string) => readFileSync(file, "utf8");
const gitIdentity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
const resolver = path.join(
  repoRoot,
  "scripts/e2e/lib/npm-telegram-live/resolve-target-scenarios.mts",
);

function resolveFixture(source: string, selectedSha?: string) {
  const root = tempDirs.make("telegram-frozen-command-");
  const target = path.join(root, "target");
  const file = path.join(target, scenarioPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(...gitIdentity, "commit", "-qm", "target");
  const sha = git("rev-parse", "HEAD");
  const output = path.join(root, "github.env");
  execFileSync(process.execPath, [resolver, target], {
    env: { ...process.env, OPENCLAW_SELECTED_SHA: selectedSha ?? sha, GITHUB_ENV: output },
    stdio: "pipe",
  });
  const lines = read(output).trim().split("\n");
  return { sha, env: Object.fromEntries(lines.map((line) => line.split(/[=](.*)/su, 2))) };
}

function captureSuiteMounts(overlay?: string) {
  const script = read(path.join(repoRoot, "scripts/e2e/npm-telegram-live-docker.sh"));
  const start = script.indexOf("command_scenario_mount_args=()");
  const mountCall = script.slice(start, script.indexOf(" bash -s <<'EOF'", start));
  const capture = `
docker_env=(-e FIXTURE=1)
prepublish_registry_mount_args=()
ROOT_DIR=/trusted
OUTPUT_DIR_HOST=/output
OUTPUT_DIR_CONTAINER=/app/output
harness_package_json=/trusted/package.json
npm_prefix_host=/npm
IMAGE_NAME=fixture
run_logged_print_heartbeat() { printf '%s\\n' "$@"; }
${mountCall}
`;
  return execFileSync("/bin/bash", ["-eu", "-c", capture], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO: overlay ?? "" },
  })
    .trim()
    .split("\n");
}

it("mounts a source-qualified trusted denial action without changing restored command proof", () => {
  // Frozen YAML selects the contract but must never supply executable expressions.
  const { sha, env } = resolveFixture(
    trusted.replace(silent, explicit).replace("title:", "# target-only-untrusted-content\ntitle:"),
  );
  const overlay = env.OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO;
  assert.ok(overlay);
  const actual = read(overlay);
  expect(actual).toContain(`# Frozen package source ${sha}: explicit authorization denial.`);
  expect(actual).not.toContain("target-only-untrusted-content");
  expect(YAML.parse(actual)).toEqual(YAML.parse(trusted.replace(silent, explicit)));
  expect(env.OPENCLAW_NPM_TELEGRAM_OMIT_DEFAULT_SCENARIOS).not.toContain(
    "telegram-repeated-command-authorization",
  );
  const mounts = captureSuiteMounts(overlay);
  const baseIndex = mounts.indexOf("/trusted/qa/scenarios:/app/qa/scenarios:ro");
  expect(baseIndex).toBeGreaterThan(0);
  expect(mounts.indexOf(`${overlay}:/app/${scenarioPath}:ro`)).toBeGreaterThan(baseIndex);
});

it("keeps current silent denial on the normal trusted scenario mount", () => {
  const { env } = resolveFixture(trusted);
  expect(env.OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO).toBeUndefined();
  expect(captureSuiteMounts().filter((arg) => arg.includes(scenarioPath))).toEqual([]);
});

it("refuses unknown source contracts and mismatched selected source identities", () => {
  expect(() => resolveFixture(trusted.replace(silent, ""))).toThrow();
  expect(() => resolveFixture(trusted.replace(silent, explicit), "0".repeat(40))).toThrow();
  expect(() => captureSuiteMounts("/missing/frozen-scenario.yaml")).toThrow();
});
