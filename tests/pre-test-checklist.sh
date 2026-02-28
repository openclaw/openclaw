#!/bin/bash
# Quick Pre-Test Checklist for Hostinger VPS Deployment
# Run this BEFORE sending regression test messages to LINE bot
# Usage: bash tests/pre-test-checklist.sh

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONTAINER="openclaw-sgnl-openclaw-1"

echo -e "${BLUE}┌─────────────────────────────────────────────────────────────────────────┐"
echo -e "│ OpenClaw VPS Pre-Test Checklist v2026.2.27-ws23+                       │"
echo -e "│ Run this BEFORE testing suite                                          │"
echo -e "└─────────────────────────────────────────────────────────────────────────┘${NC}\n"

# 1. Container Status
echo -e "${YELLOW}[1] Container Status${NC}"
if docker ps --filter "name=$CONTAINER" --format "{{.Names}}" | grep -q "$CONTAINER"; then
    echo -e "  ${GREEN}✓${NC} Container is running"
else
    echo -e "  ${RED}✗${NC} Container is NOT running"
    echo "    Run: docker compose up -d"
    exit 1
fi

# 2. Volume Mounts
echo -e "\n${YELLOW}[2] Volume Mounts${NC}"
vol=$(docker inspect $CONTAINER --format='{{range .Mounts}}{{if eq .Destination "/data/.openclaw"}}{{.Source}}{{end}}{{end}}')
if [ -n "$vol" ]; then
    echo -e "  ${GREEN}✓${NC} /data/.openclaw mounted to: $vol"
else
    echo -e "  ${RED}✗${NC} Volume mount /data/.openclaw NOT FOUND"
    echo "    Run: docker inspect $CONTAINER | grep -A5 openclaw-state"
    exit 1
fi

# 3. Config File
echo -e "\n${YELLOW}[3] Configuration Files${NC}"
if docker exec $CONTAINER test -f /data/.openclaw/openclaw.json; then
    echo -e "  ${GREEN}✓${NC} openclaw.json exists"
    config_valid=$(docker exec $CONTAINER node openclaw.mjs config list 2>/dev/null | jq -r '.valid // "error"' || echo "error")
    if [ "$config_valid" = "true" ]; then
        echo -e "  ${GREEN}✓${NC} Config is valid"
    else
        echo -e "  ${YELLOW}⚠${NC} Config validation returned: $config_valid"
    fi
else
    echo -e "  ${RED}✗${NC} openclaw.json NOT FOUND"
    exit 1
fi

# 4. Environment Variables
echo -e "\n${YELLOW}[4] Environment Variables${NC}"
declare -A required_vars=(
    ["OPENROUTER_API_KEY"]="OpenRouter"
    ["BRAVE_API_KEY"]="Brave Search"
    ["OPENCLAW_GATEWAY_TOKEN"]="Gateway Auth"
)

all_set=true
for var in "${!required_vars[@]}"; do
    val=$(docker exec $CONTAINER sh -c "echo \${${var}:-}" 2>/dev/null || echo "")
    if [ -n "$val" ] && [ "$val" != "" ]; then
        masked="${val:0:8}...${val: -4}"
        echo -e "  ${GREEN}✓${NC} $var ($masked)"
    else
        echo -e "  ${RED}✗${NC} $var NOT SET"
        all_set=false
    fi
done

if [ "$all_set" = false ]; then
    echo -e "\n  ${YELLOW}Fix with:${NC} bash docker/scripts/check-env.sh"
    exit 1
fi

# 5. Tools Configuration
echo -e "\n${YELLOW}[5] Tools Configuration${NC}"

# session_status
echo -n "  session_status: "
docker logs --since=5m $CONTAINER 2>&1 | grep -q "Unknown sessionId" && echo -e "${RED}✗ Errors found${NC}" || echo -e "${GREEN}✓ No errors${NC}"

# exec allowlist
exec_security=$(docker exec $CONTAINER node openclaw.mjs config get tools.exec.security 2>/dev/null || echo "")
if [ "$exec_security" = "allowlist" ]; then
    echo -e "  ${GREEN}✓${NC} exec.security = allowlist"
else
    echo -e "  ${RED}✗${NC} exec.security = $exec_security (expected 'allowlist')"
fi

exec_host=$(docker exec $CONTAINER node openclaw.mjs config get tools.exec.host 2>/dev/null || echo "")
if [ "$exec_host" = "gateway" ]; then
    echo -e "  ${GREEN}✓${NC} exec.host = gateway"
else
    echo -e "  ${RED}✗${NC} exec.host = $exec_host (expected 'gateway')"
fi

# web_search
echo -n "  web_search: "
docker logs --since=5m $CONTAINER 2>&1 | grep -q "Brave.*error\|BRAVE.*error" && echo -e "${YELLOW}⚠ Check logs${NC}" || echo -e "${GREEN}✓ OK${NC}"

# 6. Gateway Health
echo -e "\n${YELLOW}[6] Gateway Health${NC}"
health=$(docker exec $CONTAINER curl -s http://localhost:18789/health 2>/dev/null || echo "TIMEOUT")
if [ "$health" = "TIMEOUT" ] || [ -z "$health" ]; then
    echo -e "  ${RED}✗${NC} Gateway health check failed"
    echo "    Port 18789 not responding"
    exit 1
else
    echo -e "  ${GREEN}✓${NC} Gateway responding ($health)"
fi

# 7. Error Logs
echo -e "\n${YELLOW}[7] Error Logs (last 5 min)${NC}"
error_count=$(docker logs --since=5m $CONTAINER 2>&1 | grep -i "error\|fatal\|panic" | grep -v "error.*handling\|error.*user" | wc -l || echo 0)
if [ "$error_count" -eq 0 ]; then
    echo -e "  ${GREEN}✓${NC} No critical errors"
else
    echo -e "  ${YELLOW}⚠${NC} Found $error_count error entries (check: docker logs --since=5m $CONTAINER)"
fi

missing_env=$(docker logs --since=5m $CONTAINER 2>&1 | grep -c "MissingEnvVarError" || echo 0)
if [ "$missing_env" -eq 0 ]; then
    echo -e "  ${GREEN}✓${NC} No MissingEnvVarError"
else
    echo -e "  ${RED}✗${NC} Found $missing_env MissingEnvVarError entries"
    exit 1
fi

# 8. LINE Integration
echo -e "\n${YELLOW}[8] LINE Integration${NC}"
webhook_check=$(docker logs --since=10m $CONTAINER 2>&1 | grep -c "webhook\|LINE.*message\|POST.*messages" || echo 0)
if [ "$webhook_check" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} LINE messages being received"
else
    echo -e "  ${YELLOW}⚠${NC} No recent LINE message activity"
    echo "    (Normal if no messages sent in last 10 min)"
fi

# 9. Session Store
echo -e "\n${YELLOW}[9] Session Store${NC}"
session_count=$(docker exec $CONTAINER find /data/.openclaw/agents/main/sessions -name "*.jsonl" 2>/dev/null | wc -l)
echo -e "  ${GREEN}✓${NC} Active sessions: $session_count"

# 10. Backup Status
echo -e "\n${YELLOW}[10] Backup Status${NC}"
backup_count=$(docker exec $CONTAINER ls -1 /backups/openclaw.json.* 2>/dev/null | wc -l)
if [ "$backup_count" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Backups available: $backup_count"
    docker exec $CONTAINER ls -1 /backups/openclaw.json.* | tail -1 | xargs -I {} sh -c 'echo "  Latest: {} ($(stat -c %y {} | cut -d" " -f1-2))";'
else
    echo -e "  ${YELLOW}⚠${NC} No backups found (first deployment?)"
fi

# Final Summary
echo -e "\n${BLUE}┌─────────────────────────────────────────────────────────────────────────┐"
echo -e "│ Pre-Test Check Complete                                                 │"
echo -e "└─────────────────────────────────────────────────────────────────────────┘${NC}\n"

if [ "$all_set" = true ] && [ "$error_count" -eq 0 ] && [ "$missing_env" -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed! Ready to run regression tests.${NC}\n"
    echo "Next steps:"
    echo "  1. Send test messages from LINE-REGRESSION-MESSAGES.md"
    echo "  2. Verify responses match expectations"
    echo "  3. Run: bash tests/regression-tests.sh"
    exit 0
else
    echo -e "${RED}✗ Check failed. Fix issues above before proceeding.${NC}\n"
    exit 1
fi
