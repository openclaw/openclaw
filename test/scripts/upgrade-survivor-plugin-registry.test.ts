import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/e2e/upgrade-survivor-docker.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SOURCE_SHA = "a".repeat(40);
const VERSION = "2026.8.1";

function expectFinalFailure(stderr: string, exitCode: number) {
  const summary = `[upgrade-survivor] FAILED (exit ${exitCode})`;
  expect(stderr.trimEnd().split("\n").at(-1)).toBe(summary);
  expect(stderr.split("\n").filter((line) => line === summary)).toHaveLength(1);
}

function registryManifest(): string {
  return `${JSON.stringify({
    candidateVersion: VERSION,
    packages: [],
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
  })}\n`;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function runSurvivor(overrides: NodeJS.ProcessEnv = {}, shell = "bash") {
  const root = tempDirs.make("openclaw-upgrade-survivor-registry-");
  const binDir = join(root, "bin");
  const captureDir = join(root, "capture");
  const packageTarball = join(root, "openclaw-current.tgz");
  mkdirSync(binDir);
  mkdirSync(captureDir);
  writeFileSync(packageTarball, "candidate");
  writeExecutable(
    join(binDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != */scripts/test-docker-all.mjs ]] || [ "\${2:-}" != "--prepare-plugin-registry" ]; then
  exec "$REAL_NODE" "$@"
fi
printf '%s\n' "$*" >>"$CAPTURE_DIR/node-args"
printf '%s|%s|%s\n' \
  "$OPENCLAW_DOCKER_ALL_LANES" \
  "\${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS:-}" \
  "$OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS" >>"$CAPTURE_DIR/node-env"
mkdir -p "$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry"
printf '%s' "$OPENCLAW_DOCKER_ALL_LOG_DIR" >"$CAPTURE_DIR/preparation-dir"
printf '%s' "$REGISTRY_MANIFEST" \
  >"$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry/prepublish-plugin-registry.json"
printf '{"dir":"%s"}\n' "$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry"
`,
  );
  writeExecutable(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CAPTURE_DIR/docker-args"
if [ "\${1:-}" = run ]; then
  for arg in "$@"; do
    case "$arg" in
      *:/tmp/openclaw-worker-cleanup)
        printf '%s\\0' "$@" >"$CAPTURE_DIR/docker-cleanup-args"
        test -f "$CAPTURE_DIR/main-run-finished"
        if [ "\${FIXTURE_CLEANUP_EXIT:-0}" != 0 ]; then
          exit "$FIXTURE_CLEANUP_EXIT"
        fi
        rm -rf "\${arg%%:*}/runtime"
        exit 0
        ;;
    esac
  done
  printf '%s\\0' "$@" >"$CAPTURE_DIR/docker-run-args"
  if [ -n "\${FIXTURE_PAYLOAD_SHELL:-}" ]; then
    exec "$FIXTURE_PAYLOAD_SHELL" -c "\${!#}"
  fi
fi
previous=""
for arg in "$@"; do
  case "$arg" in
    */worker-runtime.*:*)
      mkdir -p "\${arg%%:*}/runtime"
      printf 'synthetic state' >"\${arg%%:*}/runtime/state-marker"
      ;;
  esac
  if [ "$previous" = "--cidfile" ]; then
    printf 'fake-container\n' >"$arg"
  fi
  previous="$arg"
done
if [ "\${1:-}" = run ]; then
  touch "$CAPTURE_DIR/main-run-finished"
  exit "\${FIXTURE_RUN_EXIT:-0}"
fi
`,
  );

  const result = spawnSync(shell, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAPTURE_DIR: captureDir,
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: SOURCE_SHA,
      REAL_NODE: process.execPath,
      REGISTRY_MANIFEST: registryManifest(),
      OPENCLAW_CURRENT_PACKAGE_TGZ: packageTarball,
      OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: join(root, "artifacts"),
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: join(root, "artifacts"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(root, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.7.1-2",
      OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD: "1",
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TMPDIR: root,
      ...overrides,
    },
    timeout: 30_000,
  });
  return { captureDir, packageTarball, result, root };
}

describe("standalone upgrade survivor plugin registry", () => {
  it("keeps synthetic state through inner finalization until the Docker owner joins", () => {
    const root = tempDirs.make("worker-cell-inner-finalization-");
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    const marker = join(runtime, "state-marker");
    writeFileSync(marker, "synthetic state");
    const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
    const firstPhase = source.indexOf("phase storage-preflight");
    expect(firstPhase).toBeGreaterThan(0);
    const runner = join(root, "inner.sh");
    writeFileSync(
      runner,
      `${source.slice(0, firstPhase)}
cleanup() { :; }
write_summary() { :; }
run_completed=1
on_exit 0
`,
    );
    const result = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.9.4",
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "projects-doctor",
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "0",
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: runtime,
        OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(root, "artifacts", "summary.json"),
      },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("synthetic state");
  });

  // macOS /bin/bash is 3.2; PATH may select a newer Bash. Exercise both owners.
  describe.each(process.platform === "darwin" ? ["/bin/bash", "bash"] : ["bash"])(
    "%s wrapper",
    (shell) => {
      it("reaches the direct child invocation with empty optional arguments", () => {
        const { captureDir, result } = runSurvivor(
          {
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
            OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
          },
          shell,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("unbound variable");
        expect(result.stderr).not.toContain("FAILED (exit");
        expect(readFileSync(join(captureDir, "node-env"), "utf8")).toBe(
          "update-restart-auth||base\n",
        );
        const args = readFileSync(join(captureDir, "docker-run-args"), "utf8")
          .split("\0")
          .slice(0, -1);
        expect(args).toContain("run");
        expect(args).toContain("OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE=auto-auth");
        expect(args).not.toContain("--user");
        expect(args).not.toContain("");
        expect(args.at(-2)).toBe("-lc");
      });

      it("rejects a nounset preflight failure even when Bash reports zero to EXIT", () => {
        const prelude = join(tempDirs.make("survivor-preflight-fault-"), "bash-env");
        writeFileSync(
          prelude,
          `trap 'if [[ "$BASH_COMMAND" == docker_e2e_build_or_reuse* ]]; then : "$SURVIVOR_UNSET_PREFLIGHT"; fi' DEBUG\n`,
        );
        const { captureDir, result } = runSurvivor(
          {
            BASH_ENV: prelude,
            SURVIVOR_UNSET_PREFLIGHT: undefined,
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
          },
          shell,
        );
        expect(result.stderr).toContain("SURVIVOR_UNSET_PREFLIGHT");
        expect(result.status).toBe(1);
        expectFinalFailure(result.stderr, 1);
        expect(existsSync(join(captureDir, "docker-run-args"))).toBe(false);
        expect(result.stdout).not.toContain("Docker E2E passed");
      });

      it("preserves child failure through cleanup", () => {
        const { captureDir, result } = runSurvivor(
          {
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
            FIXTURE_RUN_EXIT: "42",
          },
          shell,
        );
        expect(existsSync(join(captureDir, "docker-run-args"))).toBe(true);
        expect(result.status, result.stderr).toBe(42);
        expectFinalFailure(result.stderr, 42);
        expect(result.stdout).not.toContain("Docker E2E passed");
        expect(existsSync(readFileSync(join(captureDir, "preparation-dir"), "utf8"))).toBe(false);
      });

      it("rejects an early zero exit from the actual scenario before any application work", () => {
        const prelude = join(tempDirs.make("survivor-scenario-fault-"), "bash-env");
        writeFileSync(
          prelude,
          `trap 'if [[ "$BASH_COMMAND" == openclaw_e2e_eval_test_state_from_b64* ]]; then exit 0; fi' DEBUG\n`,
        );
        const { captureDir, result } = runSurvivor(
          {
            BASH_ENV: prelude,
            FIXTURE_PAYLOAD_SHELL: shell,
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
          },
          shell,
        );
        expect(existsSync(join(captureDir, "docker-run-args"))).toBe(true);
        expect(result.status, result.stderr).toBe(1);
        expectFinalFailure(result.stderr, 1);
        expect(result.stderr).toContain("before all assertions completed");
        expect(result.stdout).not.toContain("Docker E2E passed");
      });
    },
  );

  it.each(["direct", "published"] as const)(
    "preserves an explicitly supplied %s registry",
    (mode) => {
      const registryDir = tempDirs.make("openclaw-external-plugin-registry-");
      const manifestPath = join(registryDir, "prepublish-plugin-registry.json");
      writeFileSync(manifestPath, registryManifest());

      const { captureDir, result } = runSurvivor({
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: createHash("sha256")
          .update(readFileSync(manifestPath))
          .digest("hex"),
        ...(mode === "direct"
          ? {
              OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: undefined,
              OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
              OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
            }
          : { OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "external-only-scenario" }),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(captureDir, "node-args"))).toBe(false);
      expect(readFileSync(join(captureDir, "docker-args"), "utf8")).toContain(
        `${registryDir}:/tmp/openclaw-prepublish-plugin-registry:ro`,
      );
    },
  );

  it("prepares and mounts a planner-owned registry for the current candidate", () => {
    const { captureDir, result } = runSurvivor({
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "configured-plugin-installs",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(captureDir, "node-args"), "utf8")).toContain(
      "scripts/test-docker-all.mjs --prepare-plugin-registry",
    );
    expect(readFileSync(join(captureDir, "node-env"), "utf8")).toBe(
      "published-upgrade-survivor|openclaw@2026.7.1-2|configured-plugin-installs\n",
    );
    expect(readFileSync(join(captureDir, "docker-args"), "utf8")).toContain(
      ":/tmp/openclaw-prepublish-plugin-registry:ro",
    );
  });

  it.each([
    ["custom-plugin-siblings", "openclaw@2026.9.4"],
    ["abandoned-update", "openclaw@2026.9.4"],
    ["workshop-doctor-recovery", "openclaw@2026.9.4"],
  ])("follows the planner's no-registry decision for %s", (scenario, baseline) => {
    const { captureDir, result } = runSurvivor({
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: baseline,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(captureDir, "node-args"))).toBe(false);
    expect(existsSync(join(captureDir, "docker-run-args"))).toBe(true);
    expect(readFileSync(join(captureDir, "docker-args"), "utf8")).not.toContain(
      "/tmp/openclaw-prepublish-plugin-registry",
    );
  });

  it("does not prepare a registry for a published candidate", () => {
    const { captureDir, packageTarball, result } = runSurvivor({
      OPENCLAW_CURRENT_PACKAGE_TGZ: undefined,
      OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE: "openclaw@2026.8.1",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "published-only-scenario",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(captureDir, "node-args"))).toBe(false);
    expect(readFileSync(join(captureDir, "docker-args"), "utf8")).not.toContain(
      "/tmp/openclaw-prepublish-plugin-registry",
    );
    expect(existsSync(packageTarball)).toBe(true);
  });

  it.each(["projects-doctor", "taskflow-restoration"])(
    "isolates each %s run from retained evidence and preserves a failed runtime",
    (scenario) => {
      const artifacts = tempDirs.make("worker-cell-retained-artifacts-");
      const retained = join(artifacts, "projects-inventory.json");
      writeFileSync(retained, "previous evidence");
      const directories = [];
      for (const exitCode of ["0", "42"]) {
        const { captureDir, result } = runSurvivor({
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: artifacts,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.9.4",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
          OPENCLAW_UPGRADE_SURVIVOR_E2E_IMAGE: "worker-cleanup-fixture",
          FIXTURE_RUN_EXIT: exitCode,
        });
        expect(result.status, result.stderr).toBe(Number(exitCode));
        expect(existsSync(join(captureDir, "node-args"))).toBe(false);
        const directory = result.stdout.match(/Worker survivor artifacts: ([^\n]+)/u)?.[1] ?? "";
        expect(existsSync(directory)).toBe(true);
        directories.push(directory);
        const runtimes = readdirSync(directory).filter((name) =>
          name.startsWith("worker-runtime."),
        );
        expect(runtimes).toHaveLength(exitCode === "0" ? 0 : 1);
        const cleanupArgsPath = join(captureDir, "docker-cleanup-args");
        expect(existsSync(cleanupArgsPath)).toBe(exitCode === "0");
        if (exitCode === "0") {
          const args = readFileSync(cleanupArgsPath, "utf8").split("\0").slice(0, -1);
          expect(args[args.indexOf("--network") + 1]).toBe("none");
          expect(args[args.indexOf("--entrypoint") + 1]).toBe("rm");
          expect(args).not.toContain("--user");
          expect(args.filter((arg) => arg === "-v")).toHaveLength(1);
          expect(args[args.indexOf("-v") + 1]).toMatch(
            /\/worker-runtime\.[^:]+:\/tmp\/openclaw-worker-cleanup$/u,
          );
          expect(args.slice(-4)).toEqual([
            "worker-cleanup-fixture",
            "-rf",
            "--",
            "/tmp/openclaw-worker-cleanup/runtime",
          ]);
          expect(readFileSync(join(captureDir, "docker-run-args"), "utf8")).toContain(
            "worker-cleanup-fixture\0",
          );
        }
        if (exitCode !== "0") {
          expect(result.stderr).toContain("Preserved failed synthetic worker-cell state:");
          for (const runtime of runtimes) {
            expect(readFileSync(join(directory, runtime, "runtime", "state-marker"), "utf8")).toBe(
              "synthetic state",
            );
          }
        }
      }
      expect(new Set(directories).size).toBe(2);
      expect(readFileSync(retained, "utf8")).toBe("previous evidence");
    },
  );

  it("fails and retains state when container-owned cleanup fails", () => {
    const { captureDir, result } = runSurvivor({
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.9.4",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "taskflow-restoration",
      FIXTURE_CLEANUP_EXIT: "43",
    });
    expect(result.status, result.stderr).toBe(1);
    expectFinalFailure(result.stderr, 1);
    expect(result.stderr).toContain("Worker-cell runtime cleanup failed:");
    const args = readFileSync(join(captureDir, "docker-cleanup-args"), "utf8").split("\0");
    const mount = args[args.indexOf("-v") + 1];
    if (!mount) {
      throw new Error("Cleanup did not mount the synthetic runtime");
    }
    const runtimeRoot = mount.slice(0, mount.lastIndexOf(":"));
    expect(readFileSync(join(runtimeRoot, "runtime", "state-marker"), "utf8")).toBe(
      "synthetic state",
    );
  });
});

describe("standalone upgrade survivor live OpenAI probe", () => {
  it("fails closed before Docker when the opted-in key is missing", () => {
    const { captureDir, result } = runSurvivor({
      OPENAI_API_KEY: undefined,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
    });

    expect(result.status).toBe(2);
    expectFinalFailure(result.stderr, 2);
    expect(result.stderr).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1 requires OPENAI_API_KEY",
    );
    expect(existsSync(join(captureDir, "docker-args"))).toBe(false);
  });

  it("forwards the opted-in key by environment name without putting it in Docker arguments", () => {
    const key = "live-openai-key-must-not-appear-in-arguments";
    const { captureDir, result } = runSurvivor({
      OPENAI_API_KEY: key,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL: "openai/test-model",
    });

    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(join(captureDir, "docker-args"), "utf8");
    expect(args).toContain("-e OPENAI_API_KEY");
    expect(args).toContain("-e OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL=openai/test-model");
    expect(args).not.toContain(key);
  });
});

describe("legacy operator baseline plugin cohort", () => {
  it.each([
    ["2026.7.1-1", "2026.7.1", "latest", ""],
    ["2026.7.1-2", "2026.7.1", "latest", ""],
    ["2026.8.1", "2026.8.1", "latest", ""],
    ["2026.7.2-beta.7", "2026.7.2-beta.7", "beta", ""],
    ["2026.8.1-alpha.3", "2026.8.1-alpha.3", "alpha", ""],
    ["2026.8.1-beta.1", "2026.8.1-beta.1", "beta", "E404"],
    ["2026.8.1-beta.1", "2026.8.1-beta.1", "beta", "ECONNRESET"],
  ])(
    "checks the published plugin cohort for core %s (%s, %s, %s)",
    (baseline, pluginVersion, tag, errorCode) => {
      const root = tempDirs.make("openclaw-survivor-plugin-cohort-");
      const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
      const runner = join(root, "run.sh");
      // Exercise registry preparation and installation together; only external
      // npm/CLI operations are replaced so a corrected core never pins a nonexistent plugin.
      writeFileSync(
        runner,
        `${source.slice(0, source.indexOf("phase storage-preflight"))}
trap - EXIT ERR HUP INT TERM
baseline_version="$BASELINE_VERSION"
candidate_version=2026.9.4
npm() {
  if [ -n "$NPM_LOOKUP_ERROR" ]; then
    printf '%s\\n' "$NPM_LOOKUP_RESULT"
    return 1
  fi
  if [ "$1" = view ]; then
    printf '%s\\n' "$NPM_LOOKUP_RESULT"
    return
  fi
  printf '%s\\n' "$2" >"$CAPTURE_DIR/packed-spec"
  printf 'discord.tgz\\n'
}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_prepublish_plugin_registry_start() {
  printf '%s\\n' "$@" >"$CAPTURE_DIR/registry-args"
  printf '%s\\n' "$OPENCLAW_NPM_REGISTRY_DIST_TAGS" >"$CAPTURE_DIR/dist-tags"
}
openclaw_e2e_fixture_plugin_command() {
  printf '%s\\n' "$@" >"$CAPTURE_DIR/install-args"
}
node() {
  if [ "$1" = scripts/e2e/lib/upgrade-survivor/assertions.mjs ]; then
    printf '%s\\n' "$@" >"$CAPTURE_DIR/assert-args"
  else
    command node "$@"
  fi
}
configure_plugin_registry baseline
cp "$CAPTURE_DIR/dist-tags" "$CAPTURE_DIR/baseline-dist-tags"
cp "$CAPTURE_DIR/registry-args" "$CAPTURE_DIR/baseline-registry-args"
install_companion_plugins
configure_plugin_registry
if [ "$baseline_companion_availability" = unavailable ]; then
  assert_prepublish_plugin_install
fi
write_summary passed ""
printf '%s\\n' "$baseline_version" >"$CAPTURE_DIR/core-version"
`,
      );
      const result = spawnSync("bash", [runner], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          BASELINE_VERSION: baseline,
          CAPTURE_DIR: root,
          NPM_LOOKUP_ERROR: errorCode ?? "",
          NPM_LOOKUP_RESULT: JSON.stringify(
            errorCode ? { error: { code: errorCode } } : pluginVersion,
          ),
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: `openclaw@${baseline}`,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(root, "runtime"),
          OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(root, "artifacts", "summary.json"),
          OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: join(root, "candidate.tgz"),
        },
      });
      if (errorCode === "ECONNRESET") {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Could not verify published companion");
        expect(existsSync(join(root, "install-args"))).toBe(false);
        return;
      }
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const unavailable = errorCode === "E404";
      const summary = JSON.parse(readFileSync(join(root, "artifacts", "summary.json"), "utf8"));
      expect(summary.baselineCompanion).toEqual({
        package: "@openclaw/discord",
        version: pluginVersion,
        availability: unavailable ? "unavailable" : "available",
        reason: unavailable ? "Exact companion version is not published on npm (E404)." : null,
      });
      if (unavailable) {
        expect(result.stdout).toContain("Skipping baseline companion");
        expect(existsSync(join(root, "packed-spec"))).toBe(false);
        expect(existsSync(join(root, "install-args"))).toBe(false);
        expect(existsSync(join(root, "assert-args"))).toBe(false);
        expect(readFileSync(join(root, "registry-args"), "utf8")).toContain("openclaw\n2026.9.4\n");
        return;
      }
      expect(readFileSync(join(root, "packed-spec"), "utf8")).toBe(
        `@openclaw/discord@${pluginVersion}\n`,
      );
      for (const { file, expectedVersion } of [
        { file: "baseline-dist-tags", expectedVersion: pluginVersion },
        { file: "dist-tags", expectedVersion: "2026.9.4" },
      ]) {
        const tags = Object.fromEntries(
          readFileSync(join(root, file), "utf8")
            .trim()
            .split(",")
            .map((entry) => entry.split("=")),
        );
        expect(tags[tag]).toBe(expectedVersion);
      }
      expect(readFileSync(join(root, "baseline-registry-args"), "utf8")).toContain(
        `@openclaw/discord\n${pluginVersion}\n`,
      );
      expect(readFileSync(join(root, "assert-args"), "utf8")).toBe(
        `scripts/e2e/lib/upgrade-survivor/assertions.mjs\nassert-baseline-plugin\n${pluginVersion}\ndiscord\n${tag}\n`,
      );
      expect(readFileSync(join(root, "install-args"), "utf8")).toBe(
        `openclaw\n--\nplugins\ninstall\n@openclaw/discord@${tag}\n--force\n`,
      );
      expect(readFileSync(join(root, "core-version"), "utf8")).toBe(`${baseline}\n`);
    },
  );
});
