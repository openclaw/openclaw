import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("retires AppArmor only after its owned container, preserving failed cleanup", () => {
  const root = createTempDir("openclaw-codex-docker-security-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "apparmor_parser"),
    `#!/bin/bash
case "$2" in
  -a) printf 'load\n' >>"$EVENTS" ;;
  -R)
    printf 'unload\n' >>"$EVENTS"
    if [[ "$SCENARIO" == unload-failed ]]; then exit 5; fi
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `
set -eu
source "$LIBRARY"
id() { printf '0\n'; }
openclaw_live_is_ci() { return 0; }
docker_e2e_docker_cmd() {
  case "$1" in
    info) printf '["name=apparmor","name=seccomp"]\n' ;;
    container) if [[ "$alive" == 1 ]]; then printf 'owned-container-id\n'; fi ;;
    inspect)
      if [[ "$SCENARIO" == foreign-owner ]]; then printf 'other-run\n'
      else printf '%s\n' "$CODEX_LIVE_CONTAINER_NAME"; fi
      ;;
    rm)
      printf 'stop\n' >>"$EVENTS"
      if [[ "$SCENARIO" == stop-failed ]]; then return 4; fi
      alive=0
      ;;
    *) return 2 ;;
  esac
}
for SCENARIO in success already-removed foreign-owner stop-failed unload-failed; do
  export SCENARIO
  printf '%s\n' "$SCENARIO" >>"$EVENTS"
  alive=1
  if [[ "$SCENARIO" == already-removed ]]; then alive=0; fi
  openclaw_codex_live_prepare_security "$POLICY_DIR"
  retained_dir="$CODEX_LIVE_SECURITY_DIR"
  cleanup_result=0
  openclaw_codex_live_cleanup_security || cleanup_result=$?
  printf 'result=%s\n' "$cleanup_result" >>"$EVENTS"
  if [[ -d "$retained_dir" ]]; then printf 'retained\n' >>"$EVENTS"; fi
done
`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        EVENTS: path.join(root, "events"),
        LIBRARY: path.resolve("scripts/lib/codex-live-docker-security.sh"),
        POLICY_DIR: path.resolve("scripts/lib/codex-live-docker-security"),
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(root, "events"), "utf8").trim().split("\n")).toEqual([
    "success",
    "load",
    "stop",
    "unload",
    "result=0",
    "already-removed",
    "load",
    "unload",
    "result=0",
    "foreign-owner",
    "load",
    "result=1",
    "retained",
    "stop-failed",
    "load",
    "stop",
    "result=4",
    "retained",
    "unload-failed",
    "load",
    "stop",
    "unload",
    "result=5",
    "retained",
  ]);
});

it("removes staged API credentials when the real wrapper cannot remove its container", () => {
  const root = createTempDir("openclaw-codex-docker-auth-cleanup-");
  const bin = path.join(root, "bin");
  const harness = path.join(root, "harness");
  const runtime = path.join(root, "runtime");
  for (const dir of [bin, runtime, path.join(root, "home"), path.join(harness, "scripts")]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync(path.resolve("scripts/lib"), path.join(harness, "scripts/lib"));
  writeFileSync(path.join(harness, "scripts/test-live-build-docker.sh"), "#!/bin/bash\nexit 0\n", {
    mode: 0o755,
  });
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
set -eu
case "$1" in
  info) printf '["name=seccomp"]\n' ;;
  run)
    name=""
    auth_file=""
    while (($#)); do
      case "$1" in
        --name) name="$2"; shift ;;
        --env-file) auth_file="$2"; shift ;;
      esac
      shift
    done
    if [[ -n "$name" ]]; then
      test -s "$auth_file"
      printf '%s\n' "$auth_file" >"$PROOF_ROOT/auth-path"
      printf '%s\n' "$name" >"$PROOF_ROOT/container-owner"
    fi
    ;;
  container) printf 'owned-container-id\n' ;;
  inspect) cat "$PROOF_ROOT/container-owner" ;;
  rm) exit 4 ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "/bin/bash",
    [path.resolve("scripts/test-live-codex-harness-docker.sh")],
    {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: path.join(root, "home"),
        RUNNER_TEMP: runtime,
        CI: "true",
        PROOF_ROOT: root,
        OPENAI_API_KEY: "test-openai-key",
        OPENCLAW_LIVE_CODEX_HARNESS_AUTH: "api-key",
        OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR: harness,
      },
    },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("Codex Docker cleanup failed");
  const stagedAuthPath = readFileSync(path.join(root, "auth-path"), "utf8").trim();
  expect(existsSync(stagedAuthPath)).toBe(false);
});
