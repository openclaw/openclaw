#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
TARGET_SCRIPT="${REPO_ROOT}/skills/morpho-sre/sentinel-triage.sh"

bash -n "$TARGET_SCRIPT"

require_host_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing host command for test: %s\n' "$1" >&2
    exit 1
  }
}

for cmd in awk bash cksum date dirname gh git grep jq sed shasum sort tr; do
  require_host_cmd "$cmd"
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sre-preflight-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
ORIG_PATH="$PATH"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if ! printf '%s\n' "$haystack" | grep -F -- "$needle" >/dev/null 2>&1; then
    printf 'missing expected text: %s\n' "$needle" >&2
    printf '%s\n' '--- output ---' >&2
    printf '%s\n' "$haystack" >&2
    printf '%s\n' '------------' >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  if printf '%s\n' "$haystack" | grep -F -- "$needle" >/dev/null 2>&1; then
    printf 'unexpected text present: %s\n' "$needle" >&2
    printf '%s\n' '--- output ---' >&2
    printf '%s\n' "$haystack" >&2
    printf '%s\n' '------------' >&2
    exit 1
  fi
}

link_real_cmd() {
  local bin_dir="$1"
  local cmd="$2"
  ln -sf "$(command -v "$cmd")" "${bin_dir}/${cmd}"
}

write_fake_kubectl() {
  local bin_dir="$1"
  local mode="$2"
  cat >"${bin_dir}/kubectl" <<EOF
#!/usr/bin/env bash
set -euo pipefail

mode="${mode}"
if [[ "\$#" -ge 2 && "\$1" == "config" && "\$2" == "current-context" ]]; then
  printf 'test-context\n'
  exit 0
fi

if [[ "\$#" -ge 4 && "\$1" == "--context" && "\$3" == "get" && "\$4" == "ns" ]]; then
  printf 'NAME STATUS AGE\n'
  printf 'morpho-dev Active 1d\n'
  printf 'monitoring Active 1d\n'
  exit 0
fi

if [[ "\$#" -ge 6 && "\$1" == "--context" && "\$3" == "get" && "\$4" == "pods" ]]; then
  if [[ "\$mode" == "pods_forbidden" ]]; then
    printf 'Error from server (Forbidden): pods is forbidden for user test-user\n' >&2
    exit 1
  fi
  printf '{"items":[]}\n'
  exit 0
fi

if [[ "\$#" -ge 6 && "\$1" == "--context" && "\$3" == "get" && "\$4" == "deploy" ]]; then
  printf '{"items":[]}\n'
  exit 0
fi

if [[ "\$#" -ge 6 && "\$1" == "--context" && "\$3" == "get" && "\$4" == "events" ]]; then
  printf '{"items":[]}\n'
  exit 0
fi

printf 'unexpected kubectl invocation: %s\n' "\$*" >&2
exit 1
EOF
  chmod +x "${bin_dir}/kubectl"
}

write_fake_aws() {
  local bin_dir="$1"
  local mode="$2"
  cat >"${bin_dir}/aws" <<EOF
#!/usr/bin/env bash
set -euo pipefail

mode="${mode}"
if [[ "\$#" -ge 2 && "\$1" == "sts" && "\$2" == "get-caller-identity" ]]; then
  if [[ "\$mode" == "sts_fail" ]]; then
    printf 'ExpiredToken: token expired\n' >&2
    exit 255
  fi
  printf '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/test","UserId":"test"}\n'
  exit 0
fi

printf 'unexpected aws invocation: %s\n' "\$*" >&2
exit 1
EOF
  chmod +x "${bin_dir}/aws"
}

make_fake_bin() {
  local name="$1"
  local aws_mode="$2"
  local kubectl_mode="$3"
  local bin_dir="${TMP_ROOT}/${name}"
  mkdir -p "$bin_dir"

  for cmd in awk bash cksum date dirname gh git grep jq sed shasum sort tr; do
    link_real_cmd "$bin_dir" "$cmd"
  done
  write_fake_kubectl "$bin_dir" "$kubectl_mode"
  if [[ "$aws_mode" != "missing" ]]; then
    write_fake_aws "$bin_dir" "$aws_mode"
  fi
  printf '%s\n' "$bin_dir"
}

run_case() {
  local path_dir="$1"
  PATH="$path_dir:$ORIG_PATH" \
    HOME="$TMP_ROOT/home" \
    INCIDENT_STATE_DIR="$TMP_ROOT/state" \
    SCOPE_NAMESPACES="morpho-dev,monitoring" \
    bash "$TARGET_SCRIPT" 2>&1 || true
}

case_missing_aws() {
  local bin_dir output
  bin_dir="$(make_fake_bin "missing-aws" "missing" "ok")"
  output="$(run_case "$bin_dir")"
  assert_not_contains "$output" $'reason\tHard preflight failed'
  assert_not_contains "$output" $'=== abort_reason ==='
  assert_contains "$output" $'state\tok'
}

case_aws_sts_failure() {
  local bin_dir output
  bin_dir="$(make_fake_bin "aws-sts-fail" "sts_fail" "ok")"
  output="$(run_case "$bin_dir")"
  assert_not_contains "$output" $'reason\tHard preflight failed'
  assert_not_contains "$output" $'=== abort_reason ==='
  assert_contains "$output" $'state\tok'
}

case_step01_forbidden() {
  local bin_dir output
  bin_dir="$(make_fake_bin "step01-forbidden" "ok" "pods_forbidden")"
  output="$(run_case "$bin_dir")"
  assert_contains "$output" $'01\terror\t'
  assert_contains "$output" $'command\tstep_01'
  assert_contains "$output" '__STEP_FAILURE_COMMAND__ kubectl --context "$K8S_CONTEXT" get pods -A -o json'
  assert_contains "$output" 'Error from server (Forbidden): pods is forbidden for user test-user'
  assert_contains "$output" $'reason\tCore cluster signals unavailable (Step 1)'
}

case_missing_aws
case_aws_sts_failure
case_step01_forbidden

printf 'PASS: sentinel preflight and blocked-mode checks\n'
