import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");

function slice(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < from) {
    throw new Error(`Expected upgrade survivor entry point ${start}`);
  }
  return source.slice(from, to);
}

// The real registry and update owners; only process boundaries are inert.
const harness = [
  slice("configure_plugin_registry() {", "\nseed_legacy_runtime_deps_symlink()"),
  slice("prepare_candidate_tarball() {", "\nassert_root_managed_vps_cli_usable()"),
].join("\n");

type Call = { argv: string[]; packageSpec: string | null; registry: string | null };

function runUpdate(params: {
  baselineVersion: string;
  candidateVersion: string;
  configureRegistry?: boolean;
}) {
  const root = tempDirs.make("survivor-extended-selector-");
  const artifacts = join(root, "artifacts");
  const bin = join(root, "bin");
  mkdirSync(artifacts);
  mkdirSync(bin);
  const calls = join(root, "calls.jsonl");
  const registries = join(root, "registries.jsonl");
  writeFileSync(calls, "");
  writeFileSync(registries, "");
  writeFileSync(
    join(bin, "openclaw"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  argv: process.argv.slice(2),
  packageSpec: process.env.OPENCLAW_UPDATE_PACKAGE_SPEC ?? null,
  registry: process.env.NPM_CONFIG_REGISTRY ?? null,
}) + "\\n");
process.exit(process.argv[2] === "update" ? 2 : 0);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -u
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_print_log() { :; }
read_installed_version() { printf '%s' "$baseline_version"; }
openclaw_prepublish_plugin_registry_start() {
  node -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({ tags: process.env.OPENCLAW_NPM_REGISTRY_DIST_TAGS ?? null, args: process.argv.slice(2) }) + "\\n")' \\
    "$REGISTRY_LOG" "$@"
  printf -v "$6" '%s' 4242
  export NPM_CONFIG_REGISTRY=http://127.0.0.1:4873
}
${harness}
ARTIFACT_ROOT=${JSON.stringify(artifacts)}
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/validate.err"
COMMAND_TIMEOUT=900s
ROOT_MANAGED_VPS=0
UPDATE_RESTART_MODE=manual
SCENARIO=base
CANDIDATE_KIND=tarball
CANDIDATE_SPEC=${JSON.stringify(join(root, "candidate.tgz"))}
candidate_tarball=""
plugin_registry_pid=""
candidate_selector_registry=0
baseline_version=${params.baselineVersion}
baseline_spec="openclaw@$baseline_version"
candidate_version=${params.candidateVersion}
${params.configureRegistry ? "configure_plugin_registry || exit 90" : ""}
update_candidate
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, REGISTRY_LOG: registries },
      timeout: 30_000,
    },
  );
  const read = (file: string) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    result,
    update: (read(calls) as Call[]).find((call) => call.argv[0] === "update"),
    registries: read(registries) as { tags: string | null; args: string[] }[],
    tarball: join(root, "candidate.tgz"),
  };
}

describe.skipIf(process.platform === "win32")("upgrade survivor extended-stable selector", () => {
  it.each([false, true])(
    "updates 2026.8.35 to 2026.9.33 through the loopback selector (fixture registry: %s)",
    (configureRegistry) => {
      const { result, update, registries, tarball } = runUpdate({
        baselineVersion: "2026.8.35",
        candidateVersion: "2026.9.33",
        configureRegistry,
      });
      // The fake updater fails after recording its invocation.
      expect(result.status, result.stderr).toBe(2);
      expect(update).toEqual({
        argv: ["update", "--yes", "--json", "--no-restart"],
        packageSpec: "openclaw",
        registry: "http://127.0.0.1:4873",
      });
      expect(registries).toHaveLength(1);
      expect(registries[0]?.args.slice(-3)).toEqual(["openclaw", "2026.9.33", tarball]);
      expect(registries[0]?.tags).toBe(
        configureRegistry
          ? "beta=2026.9.33,extended-stable=2026.9.33"
          : "extended-stable=2026.9.33",
      );
    },
  );

  it.each([
    { baselineVersion: "2026.9.9", candidateVersion: "2026.9.33", channel: [] },
    {
      baselineVersion: "2026.8.35",
      candidateVersion: "2026.10.1",
      channel: ["--channel", "stable"],
    },
  ])(
    "keeps the explicit target for $baselineVersion to $candidateVersion",
    ({ baselineVersion, candidateVersion, channel }) => {
      const { result, update, registries, tarball } = runUpdate({
        baselineVersion,
        candidateVersion,
      });
      expect(result.status, result.stderr).toBe(2);
      expect(update).toEqual({
        argv: ["update", "--tag", `file:${tarball}`, "--yes", "--json", ...channel, "--no-restart"],
        packageSpec: null,
        registry: process.env.NPM_CONFIG_REGISTRY ?? null,
      });
      expect(registries).toEqual([]);
    },
  );
});
