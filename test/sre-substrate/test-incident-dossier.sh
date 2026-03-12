#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../skills/morpho-sre" && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/lib-incident-dossier.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
export OPENCLAW_SRE_DOSSIERS_DIR="${tmp_dir}/dossiers"

incident_dossier_write_bundle \
  "incident:abc" \
  "morpho-dev" \
  "deploy_gap" \
  "high" \
  '{"version":"sre.incident.shadow.v1","incident_id":"incident:abc"}' \
  $'{"event":"detected"}\n' \
  $'{"version":"sre.evidence-row.v1","kind":"incident_summary"}\n' \
  '[{"id":"h1"}]' \
  '[{"kind":"shadow_mode"}]' \
  '[{"entity_id":"incident:abc"}]' \
  '[{"kind":"slack_thread","value":"123.456"}]'

dossier_dir="${OPENCLAW_SRE_DOSSIERS_DIR}/incident:abc"
test -f "${dossier_dir}/incident.json"
test -f "${dossier_dir}/timeline.ndjson"
test -f "${dossier_dir}/evidence.ndjson"
test -f "${dossier_dir}/hypotheses.json"
test -f "${dossier_dir}/actions.json"
test -f "${dossier_dir}/entities.json"
test -f "${dossier_dir}/links.json"
test -f "${dossier_dir}/summary.md"

jq -e '.incident_id == "incident:abc"' <"${dossier_dir}/incident.json" >/dev/null
jq -e '.[0].kind == "shadow_mode"' <"${dossier_dir}/actions.json" >/dev/null
