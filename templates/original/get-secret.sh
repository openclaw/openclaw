#!/bin/sh
# Blink Claw exec secret provider — called by OpenClaw to resolve secrets
# Usage: get-secret.sh KEY_NAME
KEY="$1"
if [ -z "$KEY" ]; then
  echo "Usage: get-secret.sh KEY_NAME" >&2
  exit 1
fi
AGENT_ID="$BLINK_AGENT_ID"
BASE_URL="${BLINK_CLAW_URL:-https://blink.new}"
curl -sf \
  -H "Authorization: Bearer $BLINK_API_KEY" \
  "$BASE_URL/api/claw/agents/$AGENT_ID/secrets/$KEY"
