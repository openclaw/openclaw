import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function shell(script: string) {
  return execFileSync("bash", ["-c", script], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: tempDirs.make("docker-custody-") },
    encoding: "utf8",
  });
}
const setup = String.raw`
set -euo pipefail
source scripts/lib/docker-e2e-package.sh
# Exercise the real owners, substituting only daemon responses and the clock.
# No actual Docker daemon, timer, process-tree probe, or Gateway is needed.
timeout() {
  if [ "$1" = --kill-after=1s ]; then return 0; fi
  shift 2
  "$@"
}
docker() {
  case "$1" in
    run)
      shift
      while [ "$1" != --cidfile ]; do shift; done
      printf '%s\n' "$2" >"$TMPDIR/cid-path"
      case "$cid_shape" in
        valid) printf '%064d\n' 1 >"$2" ;;
        empty) : >"$2" ;;
        name) printf 'mutable-name\n' >"$2" ;;
        missing) : ;;
      esac
      return "$run_exit" ;;
    rm)
      test "$2" = -f
      test "$3" = "$(printf '%064d' 1)"
      printf 'rm\n' >>"$TMPDIR/events"
      return "$rm_exit" ;;
    inspect) printf 'ExitCode=%s\n' "$run_exit" ;;
    *) return 91 ;;
  esac
}
docker_e2e_timeout_bin() { printf 'timeout\n'; }
`;

describe("Docker harness custody", () => {
  it("retains unsettled CID and package inputs, primary status, traps and caller fds", () => {
    expect(
      shell(
        setup +
          String.raw`
for execution in direct subshell; do
for run_exit in 0 7 124; do
  for rm_exit in 0 9; do
    for cid_shape in valid empty missing name; do
      (
        mkdir "$TMPDIR/package"
        touch "$TMPDIR/package/.openclaw-docker-e2e-generated-package"
        printf fixture >"$TMPDIR/package/openclaw-current.tgz"
        docker_e2e_package_mount_args "$TMPDIR/package/openclaw-current.tgz"
        trap : INT
        trap '' TERM
        trap - HUP
        before_traps="$(trap -p INT TERM HUP)"
        exec 19>"$TMPDIR/caller-fd"
        result=0
        if [ "$execution" = direct ]; then
          docker_e2e_run_with_harness image -v "$TMPDIR/package/openclaw-current.tgz:/pkg:ro" || result=$?
        else
          (docker_e2e_run_with_harness image -v "$TMPDIR/package/openclaw-current.tgz:/pkg:ro") || result=$?
        fi
        test "$(trap -p INT TERM HUP)" = "$before_traps"
        printf preserved >&19
        exec 19>&-
        test "$(cat "$TMPDIR/caller-fd")" = preserved
        # Typical caller EXIT cleanup cannot erase an unsettled package either.
        docker_e2e_cleanup_package_tgz "$TMPDIR/package/openclaw-current.tgz"
        expected=$run_exit
        cidfile="$(cat "$TMPDIR/cid-path")"
        if [ "$rm_exit" = 0 ] && [ "$cid_shape" = valid ]; then
          test ! -e "$cidfile"
          test ! -e "$TMPDIR/package"
        else
          [ "$expected" != 0 ] || expected=1
          test -d "$(dirname "$cidfile")"
          test -f "$TMPDIR/package/openclaw-current.tgz"
          if [ "$cid_shape" != missing ]; then test -f "$cidfile"; fi
        fi
        test "$result" = "$expected"
      )
      # These are inert test files, not daemon custody.
      rm -rf "$TMPDIR/package" "$TMPDIR"/openclaw-docker-e2e-container.*
    done
  done
done
done
printf passed
`,
      ),
    ).toBe("passed");
  });

  it("caps auxiliary and build commands by remaining time and refuses expired work", () => {
    expect(
      shell(String.raw`
set -euo pipefail
source scripts/lib/docker-build.sh
date() { printf '%s\n' "$clock"; }
docker_e2e_timeout_bin() { printf 'timeout\n'; }
timeout() {
  if [ "$1" = --kill-after=1s ]; then return 0; fi
  printf '%s\n' "$2" >>"$TMPDIR/timeouts"
  shift 2
  "$@"
}
docker() { printf '%s\n' "$1" >>"$TMPDIR/commands"; }
DOCKER_E2E_PHASE_DEADLINE=1000
clock=900
docker_e2e_docker_cmd logs cid
clock=920
docker_build_run_command 3600s docker build
clock=950
docker_e2e_docker_cmd commit cid
clock=970
result=0
docker_e2e_docker_cmd wait cid || result=$?
test "$result" = 124
test "$(cat "$TMPDIR/timeouts")" = $'70s\n50s\n20s'
test "$(cat "$TMPDIR/commands")" = $'logs\nbuild\ncommit'
# Cleanup owns a previously allocated absolute deadline, not a renewed timeout.
DOCKER_E2E_PHASE_DEADLINE=1040
docker_e2e_docker_cmd rm -f cid
clock=1010
result=0
docker_e2e_docker_cmd image rm image || result=$?
test "$result" = 124
test "$(tail -n 1 "$TMPDIR/timeouts")" = 40s
printf passed
`),
    ).toBe("passed");
  });
});
