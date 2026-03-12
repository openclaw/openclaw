#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
SCRIPT="$ROOT/self-improve-pr.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/repo/skills/morpho-sre/references" "$TMP/repo/skills/morpho-sre" "$TMP/state/agents/main/sessions"

cat >"$TMP/bin/repo-clone.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'path=%s\n' "$TMP/repo"
EOF
chmod +x "$TMP/bin/repo-clone.sh"

cat >"$TMP/bin/autofix-pr.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '{"status":"ok"}\n'
EOF
chmod +x "$TMP/bin/autofix-pr.sh"

cat >"$TMP/repo/skills/morpho-sre/HEARTBEAT.md" <<'EOF'
# Morpho SRE Sentinel

## Daily Self-Improvement (Managed)
<!-- self-improve:start -->
old
<!-- self-improve:end -->
EOF

git -C "$TMP/repo" init >/dev/null 2>&1

cat >"$TMP/state/agents/main/sessions/self-improve-history.jsonl" <<'EOF'
{"timestamp":"2026-03-08T01:00:00.000Z","message":{"role":"user","content":"Read HEARTBEAT.md if it exists (workspace context). Follow it strictly."}}
{"timestamp":"2026-03-08T01:00:05.000Z","message":{"role":"assistant","content":"System: [2026-03-08 01:00 UTC] Exec denied (gateway id=abc): set -euo pipefail"}}
EOF

SELF_IMPROVE_REPO_CLONE_SCRIPT="$TMP/bin/repo-clone.sh" \
SELF_IMPROVE_AUTOFIX_SCRIPT="$TMP/bin/autofix-pr.sh" \
SELF_IMPROVE_SESSIONS_DIR="$TMP/state/agents/main/sessions" \
SELF_IMPROVE_REFERENCE_TIME="2026-03-09T04:17:05Z" \
SELF_IMPROVE_USE_KUBECTL=0 \
INCIDENT_STATE_DIR="$TMP/state/sentinel" \
bash "$SCRIPT" --dry-run >/dev/null

REPORT="$TMP/repo/skills/morpho-sre/references/self-improvement-latest.md"
HEARTBEAT="$TMP/repo/skills/morpho-sre/HEARTBEAT.md"

jq -Rn --rawfile report "$REPORT" '
  ($report | contains("failure_proposals: 0")) and
  ($report | contains("bot_repo_proposals (morpho-org/openclaw-sre): 0")) and
  ($report | contains("infra_repo_proposals (morpho-org/morpho-infra-helm): 0"))
' | grep -qx 'true'

rg -F 'Ignore heartbeat/system-prompt transcript content when preparing daily self-improve proposals.' "$HEARTBEAT" >/dev/null
rg -F 'Preserve the plain-English incident summary contract in HEARTBEAT.md' "$HEARTBEAT" >/dev/null
