import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as io from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");

const slice = (start: string, end: string) =>
  source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

// The real registry and update owners; only process boundaries are inert.
const harness = [
  slice("configure_plugin_registry() {", "\nseed_legacy_runtime_deps_symlink()"),
  slice("prepare_candidate_tarball() {", "\nassert_root_managed_vps_cli_usable()"),
].join("\n");

type Call = { argv: string[]; packageSpec: string | null; registry: string | null };

it.skipIf(process.platform === "win32").each([
  ["2026.8.35", "2026.9.33", false, "selector"],
  ["2026.8.35", "2026.9.33", true, "selector"],
  ["2026.9.9", "2026.9.33", false, "target"],
  ["2026.8.35", "2026.10.1", false, "stable"],
] as const)(
  "routes %s to %s (registry=%s, %s)",
  (baselineVersion, candidateVersion, configureRegistry, route) => {
    const root = tempDirs.make("survivor-extended-selector-");
    const calls = join(root, "calls.jsonl");
    const registries = join(root, "registries.jsonl");
    writeFileSync(calls, "");
    writeFileSync(registries, "");
    io.writeExecutable(
      join(root, "openclaw"),
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  argv: process.argv.slice(2),
  packageSpec: process.env.OPENCLAW_UPDATE_PACKAGE_SPEC ?? null,
  registry: process.env.NPM_CONFIG_REGISTRY ?? null,
}) + "\\n");
process.exit(process.argv[2] === "update" ? 2 : 0);
`,
    );
    const result = io.runProcess(
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
ARTIFACT_ROOT=${JSON.stringify(root)}
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
baseline_version=${baselineVersion}
baseline_spec="openclaw@$baseline_version"
candidate_version=${candidateVersion}
${configureRegistry ? "configure_plugin_registry || exit 90" : ""}
update_candidate
`,
      ],
      { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, REGISTRY_LOG: registries },
      30_000,
    );
    expect(result.status, result.stderr).toBe(2);
    const update = io.readJsonLines<Call>(calls).find((call) => call.argv[0] === "update");
    const registered = io.readJsonLines<{ tags: string | null; args: string[] }>(registries);
    const tarball = join(root, "candidate.tgz");
    expect(update).toEqual({
      argv: [
        "update",
        ...(route === "selector" ? [] : ["--tag", `file:${tarball}`]),
        "--yes",
        "--json",
        ...(route === "stable" ? ["--channel", "stable"] : []),
        "--no-restart",
      ],
      packageSpec: route === "selector" ? "openclaw" : null,
      registry:
        route === "selector" ? "http://127.0.0.1:4873" : (process.env.NPM_CONFIG_REGISTRY ?? null),
    });
    if (route === "selector") {
      expect(registered).toHaveLength(1);
      expect(registered[0]?.args.slice(-3)).toEqual(["openclaw", candidateVersion, tarball]);
      expect(registered[0]?.tags).toBe(
        `${configureRegistry ? "beta=2026.9.33," : ""}extended-stable=2026.9.33`,
      );
    } else {
      expect(registered).toEqual([]);
    }
  },
);
