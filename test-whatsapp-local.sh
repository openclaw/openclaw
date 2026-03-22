#!/bin/bash
# Test script: verify WhatsApp QR flow works in a locally-built Blink Claw Docker image.
# Runs the WebSocket RPC test INSIDE the container (avoids bind/origin issues).
# Usage: ./test-whatsapp-local.sh [image-name]
# Default image: blink-claw-test:local

set -e

IMAGE="${1:-blink-claw-test:local}"
CONTAINER_NAME="blink-claw-whatsapp-test"
GATEWAY_TOKEN="test-token-abc123"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  rm -rf "$TEST_DATA" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Using image: $IMAGE"

# Create data dir with proper openclaw.json (includes dangerouslyDisableDeviceAuth)
TEST_DATA=$(mktemp -d)
mkdir -p "$TEST_DATA/workspace/.whatsapp" "$TEST_DATA/agents/main/agent"
chmod -R 777 "$TEST_DATA"
cat > "$TEST_DATA/openclaw.json" << 'EOF'
{
  "agents": { "defaults": { "workspace": "/data/workspace" } },
  "gateway": {
    "auth": { "mode": "token" },
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "browser": { "noSandbox": true },
  "channels": {
    "whatsapp": {
      "accounts": { "default": { "authDir": "/data/workspace/.whatsapp" } }
    }
  }
}
EOF

echo ""
echo "==> Starting container with WhatsApp config..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -e OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
  -e OPENCLAW_STATE_DIR="/data" \
  -e OPENCLAW_HEADLESS="true" \
  -e NODE_ENV="production" \
  -v "$TEST_DATA:/data" \
  "$IMAGE" \
  node openclaw.mjs gateway --allow-unconfigured

echo "==> Waiting for gateway to start (WhatsApp init takes ~90s)..."
for i in $(seq 1 150); do
  if docker exec "$CONTAINER_NAME" node -e \
    "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    > /dev/null 2>&1; then
    echo "    Gateway healthy after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" -eq 150 ]; then
    echo "    ERROR: Gateway did not start within 150s"
    echo ""
    echo "==> Container logs:"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -40
    exit 1
  fi
done

echo ""
echo "==> Testing web.login.start RPC (WhatsApp QR) from inside container..."

# Copy the RPC test script into the container and run it from /app (has node_modules/ws)
docker cp "$SCRIPT_DIR/test-whatsapp-rpc.mjs" "$CONTAINER_NAME:/app/test-whatsapp-rpc.mjs"
RESULT=$(docker exec -w /app -e GATEWAY_TOKEN="$GATEWAY_TOKEN" "$CONTAINER_NAME" node test-whatsapp-rpc.mjs 2>/dev/null)

echo ""
echo "==> RPC result: $RESULT"

if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' in d else 1)" 2>/dev/null; then
  ERROR=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "$RESULT")
  echo ""
  if echo "$ERROR" | grep -q "provider is not available"; then
    echo "FAIL: WhatsApp extension is NOT loaded in the runtime image."
    echo "      Error: $ERROR"
    echo "      => The Dockerfile fix (add extensions/whatsapp COPY) is needed."
  else
    echo "FAIL: WhatsApp RPC returned error: $ERROR"
  fi
  echo ""
  echo "==> Container logs:"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -40
  exit 1
else
  HAS_QR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hasQrDataUrl', False))" 2>/dev/null || echo "false")
  MSG=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null || echo "")

  if [ "$HAS_QR" = "True" ]; then
    echo ""
    echo "PASS: WhatsApp QR code generated successfully!"
    echo "      The extension is loaded. Baileys connected to WhatsApp servers."
    echo "      QR is ready to be scanned."
  elif echo "$MSG" | grep -qi "already linked"; then
    echo ""
    echo "PASS: WhatsApp reports already linked."
  else
    echo ""
    echo "PASS: web.login.start responded. Message: $MSG"
  fi
fi

echo ""
echo "==> Container logs (last 20 lines):"
docker logs "$CONTAINER_NAME" 2>&1 | tail -20
