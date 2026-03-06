#!/usr/bin/env bash
set -euo pipefail

# Regression test for: OPENCLAW_DOCKER_APT_PACKAGES is ignored by setup-podman.sh
# We don't execute podman; we only assert the build arg is wired.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! grep -q -- '--build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}"' "$REPO_ROOT/setup-podman.sh"; then
  echo "setup-podman.sh does not pass OPENCLAW_DOCKER_APT_PACKAGES through to podman build" >&2
  exit 1
fi

echo "ok"
