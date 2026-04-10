#!/usr/bin/env bash
# Octopus Orchestrator — CI lint check entrypoint (M0-13)
#
# Runs the upstream-imports boundary check (scripts/check-octo-upstream-imports.mjs)
# from the OpenClaw repo root. Exits non-zero on any violation.
#
# This script is the stable invocation point inside the octo tree so that
# future octo-only CI steps can call a single path regardless of how the
# underlying check is implemented. Today it forwards to the bespoke node
# script per OCTO-DEC-040 (pivot from ESLint to node due to the repo's
# oxlint-only tooling). If the implementation moves, this wrapper stays
# and only the forward changes.
#
# Usage:
#   bash src/octo/ci/lint-check.sh              # run on the live tree
#   bash src/octo/ci/lint-check.sh --quiet      # suppress the OK line
#
# Exit codes (forwarded from the underlying node script):
#   0 — clean tree, no violations
#   1 — violations found
#   2 — invocation error

set -euo pipefail

# Resolve the repo root regardless of the working directory the caller
# invoked this script from. The script lives at src/octo/ci/lint-check.sh,
# so repo root is four levels up from the script's own directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

cd "${REPO_ROOT}"

exec node scripts/check-octo-upstream-imports.mjs "$@"
