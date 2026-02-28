#!/bin/bash
# Regression Test Suite for OpenClaw LINE Bot v2026.2.27-ws23+
# Covers all 9 issues (P0-P3)
# Run on VPS: bash tests/regression-tests.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CONTAINER="openclaw-sgnl-openclaw-1"
FAILED=0
PASSED=0

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "OpenClaw LINE Bot Regression Test Suite (v2026.2.27-ws23+)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Helper functions
pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((FAILED++))
}

warn() {
    echo -e "${YELLOW}⚠ WARN${NC}: $1"
}

check() {
    local name="$1"
    local cmd="$2"
    local expected="$3"
    
    echo -e "${BLUE}Testing:${NC} $name"
    result=$(eval "$cmd" 2>&1 || echo "ERROR")
    
    if [[ "$result" == *"$expected"* ]]; then
        pass "$name"
    else
        fail "$name"
        echo "  Expected substring: $expected"
        echo "  Got: $result"
    fi
}

# Pre-flight checks
echo -e "${YELLOW}[Pre-flight Checks]${NC}\n"

if ! docker ps --filter "name=$CONTAINER" --format "{{.Names}}" | grep -q "$CONTAINER"; then
    echo -e "${RED}✗ Container $CONTAINER not running${NC}"
    exit 1
fi
pass "Container $CONTAINER is running"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #1: session_status Unknown sessionId]${NC}\n"
echo "Root Cause: Volume mount mismatch (KI-009)"
echo "Expected: session_status() returns valid session info"
echo ""

check "KI-009-A: Session store mounted to correct path" \
    "docker inspect $CONTAINER --format='{{range .Mounts}}{{if eq .Destination \"/data/.openclaw\"}}OK{{end}}{{end}}'" \
    "OK"

check "KI-009-B: Config file exists on persistent volume" \
    "docker exec $CONTAINER test -f /data/.openclaw/openclaw.json && echo OK" \
    "OK"

check "KI-009-C: Sessions directory exists" \
    "docker exec $CONTAINER test -d /data/.openclaw/agents/main/sessions && echo OK" \
    "OK"

check "KI-009-D: Config valid after restart" \
    "docker exec $CONTAINER node openclaw.mjs config list | jq -r '.valid // empty'" \
    "true"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #2: exec date approval loop]${NC}\n"
echo "Root Cause: date not in DEFAULT_SAFE_BINS (KI-002)"
echo "Expected: exec date runs without approval prompt"
echo ""

check "KI-002-A: exec safeBins includes date" \
    "docker exec $CONTAINER node openclaw.mjs config get tools.exec.safeBins 2>/dev/null | jq -r '.[]? // empty' | grep -c '^date\$'" \
    "1"

check "KI-002-B: exec safeBins includes uptime" \
    "docker exec $CONTAINER node openclaw.mjs config get tools.exec.safeBins 2>/dev/null | jq -r '.[]? // empty' | grep -c '^uptime\$'" \
    "1"

check "KI-002-C: exec safeBins includes whoami" \
    "docker exec $CONTAINER node openclaw.mjs config get tools.exec.safeBins 2>/dev/null | jq -r '.[]? // empty' | grep -c '^whoami\$'" \
    "1"

check "KI-002-D: exec security mode is allowlist" \
    "docker exec $CONTAINER node openclaw.mjs config get tools.exec.security 2>/dev/null" \
    "allowlist"

check "KI-002-E: exec ask mode is on-miss" \
    "docker exec $CONTAINER node openclaw.mjs config get tools.exec.ask 2>/dev/null" \
    "on-miss"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #3: exec host not allowed]${NC}\n"
echo "Root Cause: host=sandbox requested but VPS has only host=gateway (KI-010)"
echo "Expected: tools.exec.host set to gateway"
echo ""

check "KI-010-A: exec host is gateway" \
    "docker exec $CONTAINER node openclaw.mjs config get tools.exec.host 2>/dev/null" \
    "gateway"

check "KI-010-B: No 'host not allowed' errors in logs" \
    "docker logs --since=1h $CONTAINER 2>&1 | grep -c 'host not allowed' || echo 0" \
    "0"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #4: Browser service unreachable]${NC}\n"
echo "Root Cause: OPENCLAW_INSTALL_BROWSER=1 not set during build (KI-011)"
echo "Expected: Browser available OR gracefully fallback"
echo ""

browser_check=$(docker exec $CONTAINER ls -la /home/node/.cache/ms-playwright/ 2>/dev/null | grep -c chromium || echo 0)
if [ "$browser_check" -gt 0 ]; then
    pass "KI-011-A: Chromium browser available"
else
    warn "KI-011-A: Chromium not installed (expected if OPENCLAW_INSTALL_BROWSER≠1)"
    echo "  To enable: rebuild with --build-arg OPENCLAW_INSTALL_BROWSER=1"
fi

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #5: Brave API key disappears after restart]${NC}\n"
echo "Root Cause: Volume mount mismatch + env var not persisted (KI-009, KI-012)"
echo "Expected: BRAVE_API_KEY environment variable set"
echo ""

check "KI-012-A: BRAVE_API_KEY environment variable is set" \
    "docker exec $CONTAINER sh -c 'test -n \"\${BRAVE_API_KEY:-}\" && echo SET || echo UNSET'" \
    "SET"

check "KI-012-B: BRAVE_API_KEY is not empty" \
    "docker exec $CONTAINER sh -c 'test -n \"\$(echo \${BRAVE_API_KEY:-} | tr -d '\\''\\s'\\''  )\" && echo VALID || echo EMPTY'" \
    "VALID"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #6: Embeddings config lost after restart]${NC}\n"
echo "Root Cause: Volume mount mismatch (KI-009)"
echo "Expected: Config persists after container restart"
echo ""

# Create a test config value
docker exec $CONTAINER node openclaw.mjs config set test.marker "regression-test-$(date +%s)" 2>/dev/null || true

# Wait a bit
sleep 2

check "KI-009-E: Test marker persisted to disk" \
    "docker exec $CONTAINER cat /data/.openclaw/openclaw.json 2>/dev/null | jq -r '.test.marker // empty' | grep -q regression && echo OK" \
    "OK"

# Restart container
echo -e "\n  Restarting container to verify persistence..."
docker restart $CONTAINER > /dev/null 2>&1
sleep 15  # Wait for restart

check "KI-009-F: Test marker survives container restart" \
    "docker exec $CONTAINER node openclaw.mjs config get test.marker 2>/dev/null | grep -q regression && echo OK" \
    "OK"

# Clean up test marker
docker exec $CONTAINER node openclaw.mjs config delete test 2>/dev/null || true

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #7: Docker time sync (host UTC vs container +07)]${NC}\n"
echo "Expected: Container shows +07:00 (Bangkok time), host shows UTC (intended design)"
echo ""

host_tz=$(date +%z)
container_tz=$(docker exec $CONTAINER date +%z)

echo "  Host timezone offset: $host_tz"
echo "  Container timezone offset: $container_tz"

if [ "$container_tz" = "+0700" ]; then
    pass "KI-007-A: Container timezone is +07:00 (Bangkok)"
else
    fail "KI-007-A: Container timezone is NOT +07:00, got $container_tz"
fi

check "KI-007-B: Container clock is synchronous with host" \
    "docker exec $CONTAINER date +%s | awk '{now=\$1} END {exit (now < $(date +%s) - 10 || now > $(date +%s) + 10) ? 1 : 0}' && echo OK" \
    "OK"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #8: Reply message context (Deferred)]${NC}\n"
echo "Status: P3 - Deferred to GitHub issue"
echo "Reason: Architectural limitation (LINE API doesn't expose reply parent IDs)"
warn "KI-008: Deferred to future workstream (GitHub issue TBD)"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Issue #9: Auto memory save (Deferred)]${NC}\n"
echo "Status: P3 - Deferred to GitHub issue"
echo "Reason: Requires new skill development (auto-memory-save)"
warn "KI-009: Deferred to future workstream (GitHub issue TBD)"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Gateway Health]${NC}\n"

check "Gateway health check port 18789" \
    "docker exec $CONTAINER curl -s http://localhost:18789/health || echo TIMEOUT" \
    "200\|OK\|healthy"

check "Gateway status check (no startup errors)" \
    "docker logs --since=5m $CONTAINER 2>&1 | grep -c 'Error\|FATAL\|panic' || echo 0" \
    "0"

check "No missing environment variable errors" \
    "docker logs --since=5m $CONTAINER 2>&1 | grep -c 'MissingEnvVarError' || echo 0" \
    "0"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}[Deployment Checklist]${NC}\n"

echo "✓ Pre-flight:"
docker ps --filter "name=$CONTAINER" --format "table {{.Names}}\t{{.Status}}"

echo ""
echo "✓ Volume mounts:"
docker inspect $CONTAINER --format='Mounts: {{len .Mounts}} configured'

echo ""
echo "✓ Config file:"
docker exec $CONTAINER test -f /data/.openclaw/openclaw.json && echo "  Config file exists" || echo "  Config file MISSING"

echo ""
echo "✓ Backup status:"
docker exec $CONTAINER ls -1 /backups/openclaw.json.* 2>/dev/null | tail -3 || echo "  (no backups yet)"

# ───────────────────────────────────────────────────────────────────────────
echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Test Results${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

total=$((PASSED + FAILED))
echo -e "Passed: ${GREEN}$PASSED${NC} / $total"
echo -e "Failed: ${RED}$FAILED${NC} / $total"

if [ $FAILED -eq 0 ]; then
    echo -e "\n${GREEN}✓ All regression tests passed!${NC}\n"
    exit 0
else
    echo -e "\n${RED}✗ $FAILED test(s) failed. See details above.${NC}\n"
    exit 1
fi
