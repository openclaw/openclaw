#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/consumer-bug-preflight.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"${TMP}/resolver.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"env":"prd","posthog":{"top":{"key":"vmv1"}},"sentry":{"top":{"key":"morpho-consumer"}}}'
EOF

cat >"${TMP}/posthog.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"ok":true,"projectId":"123","source":"posthog"}'
EOF

cat >"${TMP}/sentry.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'authenticated as sentry-user'
EOF

cat >"${TMP}/linear.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"ok":true,"viewerId":"viewer-1","viewerName":"Test User"}'
EOF

cat >"${TMP}/cast" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'cast mock'
EOF

cat >"${TMP}/anvil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'anvil mock'
EOF

chmod +x "${TMP}/resolver.sh" "${TMP}/posthog.sh" "${TMP}/sentry.sh" "${TMP}/linear.sh" "${TMP}/cast" "${TMP}/anvil"

out="$(
  CONSUMER_BUG_PREFLIGHT_RESOLVER="${TMP}/resolver.sh" \
  CONSUMER_BUG_PREFLIGHT_POSTHOG="${TMP}/posthog.sh" \
  CONSUMER_BUG_PREFLIGHT_SENTRY="${TMP}/sentry.sh" \
  CONSUMER_BUG_PREFLIGHT_LINEAR="${TMP}/linear.sh" \
  CONSUMER_BUG_PREFLIGHT_CAST_BIN="${TMP}/cast" \
  CONSUMER_BUG_PREFLIGHT_ANVIL_BIN="${TMP}/anvil" \
  "${SCRIPT_PATH}" prd "USDT repay fails unless offchain approval is disabled"
)"

printf '%s\n' "$out" | jq -e '.env == "prd"' >/dev/null
printf '%s\n' "$out" | jq -e '.resolver.ok == true' >/dev/null
printf '%s\n' "$out" | jq -e '.resolver.data.posthog.top.key == "vmv1"' >/dev/null
printf '%s\n' "$out" | jq -e '.posthog.ok == true' >/dev/null
printf '%s\n' "$out" | jq -e '.posthog.data.projectId == "123"' >/dev/null
printf '%s\n' "$out" | jq -e '.sentry.ok == true' >/dev/null
printf '%s\n' "$out" | jq -e '.linear.ok == true' >/dev/null
printf '%s\n' "$out" | jq -e '.linear.data.viewerId == "viewer-1"' >/dev/null
printf '%s\n' "$out" | jq -e '.foundry.ok == true' >/dev/null

cat >"${TMP}/sentry-fail.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "auth failed: 401" >&2
exit 1
EOF
chmod +x "${TMP}/sentry-fail.sh"

fail_out="$(
  CONSUMER_BUG_PREFLIGHT_RESOLVER="${TMP}/resolver.sh" \
  CONSUMER_BUG_PREFLIGHT_POSTHOG="${TMP}/posthog.sh" \
  CONSUMER_BUG_PREFLIGHT_SENTRY="${TMP}/sentry-fail.sh" \
  CONSUMER_BUG_PREFLIGHT_LINEAR="${TMP}/linear.sh" \
  CONSUMER_BUG_PREFLIGHT_CAST_BIN="${TMP}/cast" \
  CONSUMER_BUG_PREFLIGHT_ANVIL_BIN="${TMP}/anvil" \
  "${SCRIPT_PATH}" prd "test failure path"
)"

printf '%s\n' "$fail_out" | jq -e '.sentry.ok == false' >/dev/null
printf '%s\n' "$fail_out" | jq -e '.sentry.exitCode > 0' >/dev/null
printf '%s\n' "$fail_out" | jq -e '.sentry.error == "auth failed: 401 "' >/dev/null
