#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Gemmaclaw Provision E2E Test
#
# Provisions a backend, sends a chat completion, asserts non-empty reply.
#
# Usage:
#   ./provision-e2e.sh ollama       # Test Ollama backend
#   ./provision-e2e.sh llama-cpp    # Test llama.cpp backend
#   ./provision-e2e.sh gemma-cpp    # Test gemma.cpp backend (requires HF_TOKEN)
#   ./provision-e2e.sh all          # Test all three
#
# Environment variables:
#   GEMMACLAW_HOME  — Override install directory (default: ~/.gemmaclaw)
#   HF_TOKEN        — HuggingFace token (required for gemma-cpp)
#   OLLAMA_TEST_MODEL — Override Ollama model for CI (default: qwen2.5:0.5b)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use the built CLI.
GEMMACLAW="node ${REPO_ROOT}/gemmaclaw.mjs"

PASS=0
FAIL=0
SKIP=0

log()  { echo "=== $*"; }
pass() { log "PASS: $1"; PASS=$((PASS + 1)); }
fail() { log "FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { log "SKIP: $1"; SKIP=$((SKIP + 1)); }

# ─────────────────────────────────────────────────────────────────────────────
# Test a single backend.
# ─────────────────────────────────────────────────────────────────────────────
test_backend() {
  local backend="$1"
  log "Testing backend: $backend"

  # Special checks.
  if [[ "$backend" == "gemma-cpp" ]] && [[ -z "${HF_TOKEN:-}" ]]; then
    skip "$backend (HF_TOKEN not set)"
    return 0
  fi

  # Run provision (installs runtime + pulls model + verifies completion).
  local port
  case "$backend" in
    ollama)    port=11434 ;;
    llama-cpp) port=8080  ;;
    gemma-cpp) port=11436 ;;
    *)         fail "Unknown backend: $backend"; return 1 ;;
  esac

  # Use a small model for Ollama in CI to avoid slow CPU inference.
  local model_flag=""
  if [[ "$backend" == "ollama" ]]; then
    local ci_model="${OLLAMA_TEST_MODEL:-qwen2.5:0.5b}"
    model_flag="--model $ci_model"
  fi

  log "Provisioning $backend on port $port..."
  if ! $GEMMACLAW provision --backend "$backend" --port "$port" $model_flag 2>&1; then
    log "DEBUG: GEMMACLAW_HOME=$GEMMACLAW_HOME HOME=$HOME"
    log "DEBUG: Models dir contents:"
    find "${GEMMACLAW_HOME:-$HOME/.gemmaclaw}" -type f 2>/dev/null | head -20 || true
    ls -laR "${GEMMACLAW_HOME:-$HOME/.gemmaclaw}/models/" 2>/dev/null || true
    fail "$backend provision command failed"
    return 1
  fi

  # Double-check: send our own curl request to the API.
  # For Ollama, the model name must match a pulled model (not "test").
  local curl_model="test"
  if [[ "$backend" == "ollama" ]]; then
    curl_model="${OLLAMA_TEST_MODEL:-qwen2.5:0.5b}"
  fi
  log "Sending independent verification request to $backend (model: $curl_model)..."
  local response
  response=$(curl -sf --max-time 120 \
    "http://127.0.0.1:${port}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$curl_model\",
      \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly the word OK\"}],
      \"max_tokens\": 16,
      \"temperature\": 0
    }" 2>&1) || true

  if [[ -z "$response" ]]; then
    fail "$backend returned empty curl response"
    cleanup_backend "$backend" "$port"
    return 1
  fi

  # Check that the response has a non-empty choices[0].message.content.
  local content
  content=$(echo "$response" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log((j.choices||[])[0]?.message?.content||''); }
      catch(e) { console.log(''); }
    });
  ")

  if [[ -n "$content" ]]; then
    pass "$backend (response: ${content:0:80})"
  else
    fail "$backend (empty content in response)"
    log "Raw response: $response"
  fi

  cleanup_backend "$backend" "$port"
}

cleanup_backend() {
  local backend="$1"
  local port="$2"
  log "Cleaning up $backend..."

  # Kill processes listening on the port.
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
BACKENDS="${1:-all}"

case "$BACKENDS" in
  all)
    test_backend ollama
    test_backend llama-cpp
    test_backend gemma-cpp
    ;;
  ollama|llama-cpp|gemma-cpp)
    test_backend "$BACKENDS"
    ;;
  *)
    echo "Usage: $0 {ollama|llama-cpp|gemma-cpp|all}"
    exit 1
    ;;
esac

echo ""
log "Results: $PASS passed, $FAIL failed, $SKIP skipped"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
