#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/sre-runtime/build-runtime-image.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

FAKE_BIN="${TMP_ROOT}/bin"
FAKE_MORPHO_ROOT="${TMP_ROOT}/morpho"
LOG_DIR="${TMP_ROOT}/logs"
mkdir -p "$FAKE_BIN" "$FAKE_MORPHO_ROOT/morpho-infra" "$FAKE_MORPHO_ROOT/morpho-infra-helm" "$LOG_DIR"

cat >"${FAKE_BIN}/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

pack_dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--pack-destination" ]; then
    pack_dest="$2"
    shift 2
    continue
  fi
  shift
done

[ -n "$pack_dest" ] || exit 1
touch "${pack_dest}/openclaw-test.tgz"
printf '%s\n' "${pack_dest}/openclaw-test.tgz"
EOF
chmod +x "${FAKE_BIN}/pnpm"

cat >"${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_DOCKER_LOG:?}"
EOF
chmod +x "${FAKE_BIN}/docker"

run_case() {
  local name="$1"
  shift
  local stdout_file="${LOG_DIR}/${name}.stdout"
  local stderr_file="${LOG_DIR}/${name}.stderr"
  : >"${LOG_DIR}/${name}.docker"
  env \
    PATH="${FAKE_BIN}:$PATH" \
    FAKE_DOCKER_LOG="${LOG_DIR}/${name}.docker" \
    OPENCLAW_SRE_MORPHO_ROOT="${FAKE_MORPHO_ROOT}" \
    "$@" \
    bash "$SCRIPT" >"$stdout_file" 2>"$stderr_file"
}

run_case local_warn OPENCLAW_SRE_PUSH=1
grep -F 'warning: OPENCLAW_SRE_PUSH=1 requires OPENCLAW_SRE_BUILD_PLATFORM to be set' "${LOG_DIR}/local_warn.stderr" >/dev/null
grep -F 'build -f ' "${LOG_DIR}/local_warn.docker" >/dev/null
if grep -F -- '--push' "${LOG_DIR}/local_warn.docker" >/dev/null; then
  echo "unexpected --push for local_warn case" >&2
  exit 1
fi

run_case buildx_push OPENCLAW_SRE_PUSH=1 OPENCLAW_SRE_BUILD_PLATFORM=linux/amd64
grep -F 'buildx build --platform linux/amd64 --push' "${LOG_DIR}/buildx_push.docker" >/dev/null
