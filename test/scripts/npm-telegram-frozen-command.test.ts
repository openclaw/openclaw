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

function fixture(source: string) {
  const root = tempDirs.make("telegram-frozen-command-");
  const target = path.join(root, "target");
  const file = path.join(target, scenarioPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  execFileSync("git", ["init", "-q", target]);
  execFileSync("git", ["-C", target, "add", "."]);
  execFileSync("git", [
    "-C",
    target,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "target",
  ]);
  const sha = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const output = path.join(root, "github.env");
  return {
    root,
    sha,
    resolve: (selectedSha = sha) => {
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, "scripts/e2e/lib/npm-telegram-live/resolve-target-scenarios.mts"),
          target,
        ],
        {
          env: { ...process.env, OPENCLAW_SELECTED_SHA: selectedSha, GITHUB_ENV: output },
          stdio: "pipe",
        },
      );
      return Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const equal = line.indexOf("=");
            return [line.slice(0, equal), line.slice(equal + 1)];
          }),
      );
    },
  };
}

function captureSuiteMounts(overlay?: string) {
  const script = readFileSync(
    path.join(repoRoot, "scripts/e2e/npm-telegram-live-docker.sh"),
    "utf8",
  );
  const mountCall = script.slice(
    script.indexOf("command_scenario_mount_args=()"),
    script.indexOf(" bash -s <<'EOF'", script.indexOf("command_scenario_mount_args=()")),
  );
  return execFileSync(
    "/bin/bash",
    [
      "-eu",
      "-c",
      `
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
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO: overlay ?? "" },
    },
  )
    .trim()
    .split("\n");
}

it("mounts a source-qualified trusted denial action without changing restored command proof", () => {
  // Frozen YAML selects the contract but must never supply executable expressions.
  const f = fixture(
    trusted.replace(silent, explicit).replace("title:", "# target-only-untrusted-content\ntitle:"),
  );
  const env = f.resolve();
  const overlay = env.OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO;
  assert.ok(overlay);
  const actual = readFileSync(overlay, "utf8");
  expect(actual).toContain(`# Frozen package source ${f.sha}: explicit authorization denial.`);
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
  const env = fixture(trusted).resolve();
  expect(env.OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO).toBeUndefined();
  expect(captureSuiteMounts().filter((arg) => arg.includes(scenarioPath))).toEqual([]);
});

it("refuses unknown source contracts and mismatched selected source identities", () => {
  expect(() => fixture(trusted.replace(silent, "")).resolve()).toThrow();
  expect(() => fixture(trusted.replace(silent, explicit)).resolve("0".repeat(40))).toThrow();
  expect(() => captureSuiteMounts("/missing/frozen-scenario.yaml")).toThrow();
});
