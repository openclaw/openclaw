#!/usr/bin/env bash
set -euo pipefail

trim_env_var() {
  var_name="$1"
  if ! [[ "$var_name" =~ ^[A-Z0-9_]+$ ]]; then
    echo "trim-env:warning invalid variable name: $var_name" >&2
    return 0
  fi
  if [ "${!var_name+x}" = x ]; then
    raw_value="${!var_name}"
  else
    raw_value=""
  fi
  trimmed_value="$(printf '%s' "$raw_value" | tr -d '\r')"
  export "${var_name}=${trimmed_value}"
}

pem_to_newlines() {
  case "$1" in
    *\\n*)
      printf '%s' "$1" | awk 'BEGIN { ORS = "" } { while ((i = index($0, "\\n")) > 0) { printf "%s\n", substr($0, 1, i - 1); $0 = substr($0, i + 2) } printf "%s", $0 }'
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

pem_is_valid() {
  local pem="$1"
  if ! printf '%s' "$pem" | grep -q '^-----BEGIN '; then
    return 1
  fi
  if ! printf '%s' "$pem" | grep -q '^-----END '; then
    return 1
  fi
}

parse_git_cmd() {
  local git_cmd=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)
        shift
        [ "$#" -gt 0 ] && shift || break
        ;;
      --help)
        git_cmd="help"
        break
        ;;
      --version)
        git_cmd="version"
        break
        ;;
      --)
        shift
        [ "$#" -gt 0 ] && git_cmd="$1"
        break
        ;;
      -*)
        shift
        ;;
      *)
        git_cmd="$1"
        break
        ;;
    esac
  done
  printf '%s' "$git_cmd"
}

assert_eq() {
  if [ "$1" != "$2" ]; then
    echo "assert_eq failed: expected [$2], got [$1]" >&2
    exit 1
  fi
}

assert_success() {
  local fn="$1"
  shift
  if ! "$fn" "$@"; then
    echo "assert_success failed: $fn $*" >&2
    exit 1
  fi
}

assert_failure() {
  local fn="$1"
  shift
  if "$fn" "$@"; then
    echo "assert_failure failed: $fn $*" >&2
    exit 1
  fi
}

TEST_TRIM=$'alpha\r\nbeta'
trim_env_var TEST_TRIM
assert_eq "$TEST_TRIM" $'alpha\nbeta'

unset -v TEST_TRIM_UNSET
trim_env_var TEST_TRIM_UNSET
if [ "${TEST_TRIM_UNSET+x}" != x ]; then
  echo "expected TEST_TRIM_UNSET to be set" >&2
  exit 1
fi
test -z "${TEST_TRIM_UNSET}"

TEST_TRIM_EMPTY=""
trim_env_var TEST_TRIM_EMPTY
test -z "$TEST_TRIM_EMPTY"

literal_key='-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----'
literal_converted="$(pem_to_newlines "$literal_key")"
assert_eq "$literal_converted" $'-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----'
assert_success pem_is_valid "$literal_converted"

real_key=$'-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----'
real_converted="$(pem_to_newlines "$real_key")"
assert_eq "$real_converted" "$real_key"
assert_success pem_is_valid "$real_converted"

malformed_key='-----BEGIN PRIVATE KEY-----\nZm9v\nMALFORMED'
assert_failure pem_is_valid "$(pem_to_newlines "$malformed_key")"

empty_key=""
assert_failure pem_is_valid "$(pem_to_newlines "$empty_key")"

assert_eq "$(parse_git_cmd)" ""
assert_eq "$(parse_git_cmd status)" "status"
assert_eq "$(parse_git_cmd -C /tmp status)" "status"
assert_eq "$(parse_git_cmd -c color.ui=always status)" "status"
assert_eq "$(parse_git_cmd --help)" "help"
assert_eq "$(parse_git_cmd fetch)" "fetch"

printf 'test-github-app-token-helpers: ok\n'
