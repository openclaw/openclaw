---
title: Regression Testing Guide
description: Complete testing procedure for v2026.2.27-ws23+ fixes
---

# OpenClaw LINE Bot Regression Testing Guide

**Version:** v2026.2.27-ws23+  
**Date:** 2026-02-28  
**Scope:** All 9 issues (P0-P3), covering volume persistence, tool configuration, and VPS deployment

---

## Quick Start

```bash
# SSH into VPS
ssh root@76.13.210.250

# 1. Pre-flight check (2 min)
cd /docker/openclaw-sgnl
bash docker/scripts/check-env.sh

# 2. Run automated regression suite (5 min)
bash tests/pre-test-checklist.sh
bash tests/regression-tests.sh

# 3. Send manual LINE messages (see below)
# 4. Verify responses match expectations
```

---

## Phase 1: Pre-Deployment Verification (5 min)

### Step 1.1: Environment Validation

```bash
# SSH to VPS
ssh root@76.13.210.250

# Verify all required API keys are set
bash docker/scripts/check-env.sh
```

**Expected Output:**
```
✓ OPENCLAW_GATEWAY_TOKEN (first8....last4)
✓ OPENROUTER_API_KEY (first8....last4)
✓ BRAVE_API_KEY (first8....last4)
✓ LINE_CHANNEL_SECRET (first8....last4)
✓ LINE_CHANNEL_ACCESS_TOKEN (first8....last4)
```

**If any key is missing:**
1. Set in Hostinger Control Panel → Environment Variables
2. Restart container: `docker compose down && docker compose up -d`
3. Re-run check: `bash docker/scripts/check-env.sh`

### Step 1.2: Container Status

```bash
# Verify container is healthy
docker ps --filter "name=openclaw" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

**Expected Output:**
```
NAME                        STATUS              PORTS
openclaw-sgnl-openclaw-1    Up 2 minutes        18789/tcp
```

**If not running:**
```bash
docker compose up -d
sleep 15  # Wait for startup
docker logs openclaw-sgnl-openclaw-1 | tail -20
```

### Step 1.3: Gateway Health Check

```bash
# Check gateway is responding
docker exec openclaw-sgnl-openclaw-1 curl -s http://localhost:18789/health
```

**Expected Output:** `200` or `OK` or `healthy`

---

## Phase 2: Automated Regression Tests (5-10 min)

### Step 2.1: Pre-Test Checklist

```bash
bash tests/pre-test-checklist.sh
```

This validates:
- ✓ Container running
- ✓ Volume mounts correct (`/data/.openclaw/`)
- ✓ Configuration files exist and are valid
- ✓ All environment variables set
- ✓ Tools configured (session_status, exec, web_search)
- ✓ Gateway health
- ✓ No critical errors in logs
- ✓ Session store and backups

**Expected Result:** `All checks passed! Ready to run regression tests.`

### Step 2.2: Full Regression Test Suite

```bash
bash tests/regression-tests.sh
```

This verifies:
- ✓ KI-009: Volume mount path (root cause of issues #1, #5, #6)
- ✓ KI-002: exec safeBins includes date, uptime, whoami
- ✓ KI-010: exec host set to gateway
- ✓ KI-011: Browser available or fallback available
- ✓ KI-012: Environment variables not empty
- ✓ KI-007: Timezone is +07:00 (Bangkok)
- ✓ Config persistence across restarts
- ✓ No MissingEnvVarError in logs

**Expected Result:**
```
Passed: 20+ / 20+
Failed: 0 / 20+

✓ All regression tests passed!
```

**If tests fail:**
1. Check specific failure message
2. Review gateway logs: `docker logs --since=10m openclaw-sgnl-openclaw-1`
3. Verify volume mount: `docker inspect openclaw-sgnl-openclaw-1 | grep -A5 openclaw-state`
4. Check environment: `bash docker/scripts/check-env.sh`
5. See troubleshooting section below

---

## Phase 3: Manual LINE Message Testing (10-15 min)

Send these messages to the LINE bot and verify responses. Each message tests one or more issues.

### Test Group 1: session_status & Volume Persistence (Issues #1, #5, #6)

**Message 1A (Thai):**
```
ตอนนี้กี่โมงแล้วครับ
```

**Expected Response:**
- Returns current time (e.g., "เวลา 15:32 น. ค่ะ")
- No "Unknown sessionId" error
- Time matches actual +07:00 Bangkok timezone

**Message 1B (Thai):**
```
ใช้โมเดลไหน
```

**Expected Response:**
- Shows model and provider (e.g., "ใช้ Gemini 2.5 Flash ค่ะ")
- No errors

### Test Group 2: exec date Approval (Issue #2)

**Message 2A (Thai):**
```
รันคำสั่ง date
```

**Expected Response:**
- Returns date/time immediately (no approval prompt)
- Example: "Tue Feb 17 15:32:45 +07 2026"

**Message 2B (Thai):**
```
บอกเวลาปัจจุบันด้วยคำสั่ง
```

**Expected Response:**
- LLM uses exec date command
- Returns accurate time without approval loop

### Test Group 3: exec host = gateway (Issue #3)

**Message 3A (Thai):**
```
แสดงผู้ใช้ปัจจุบัน
```

**Expected Response:**
- Can execute whoami on gateway host
- Returns username (e.g., "node")
- No "host not allowed" error

**Message 3B (Thai):**
```
รันคำสั่ง ps aux | head -5
```

**Expected Response:**
- Process list returned
- No host mismatch errors

### Test Group 4: Browser or web_search Fallback (Issue #4)

**Message 4A (Thai):**
```
ค้นหาราคาทองวันนี้
```

**Expected Response:**
- Returns current gold price
- Uses web_search (if browser not available)
- No 5-second timeout

**Message 4B (Thai):**
```
ดึงข้อมูลข่าวไทยเกี่ยวกับ "บิตคอยน์"
```

**Expected Response:**
- Returns news search results
- Either uses browser (if available) or web_search
- Accurate and recent results

### Test Group 5: API Key Persistence (Issue #5)

**Message 5A (Thai):**
```
ค้นหา "ราคาเงิน" วันนี้
```

**Expected Response:**
- web_search API works
- Returns silver price/market data
- No MissingEnvVarError

**Message 5B:**
```
After restart - send the same message again
```

**Expected Response:**
- Same result (API key persisted)
- No data loss after container restart

### Test Group 6: Config Persistence (Issue #6)

**Test Procedure:**
```bash
# 1. Get current config
docker exec openclaw-sgnl-openclaw-1 node openclaw.mjs config get tools.exec.host

# 2. Restart container
docker restart openclaw-sgnl-openclaw-1
sleep 15

# 3. Check config still valid
docker exec openclaw-sgnl-openclaw-1 node openclaw.mjs config get tools.exec.host

# 4. Send LINE message
```

**Expected Result:**
- Config value same before and after restart
- Gateway responds to LINE messages immediately
- No "Unknown sessionId" after restart

### Test Group 7: Timezone Handling (Issue #7)

**Message 7A (Thai):**
```
ตอนนี้เป็นเวลาท้องถิ่นไหน
```

**Expected Response:**
- Shows Bangkok timezone (+07:00)
- Accurate time

**VPS Verification:**
```bash
# Host timezone (UTC)
date

# Container timezone (UTC+7)
docker exec openclaw-sgnl-openclaw-1 date

# Both should show same actual time, different timezone display
```

### Test Group 8: Combined Workflow (All Issues)

**Message 8 (Thai):**
```
บอกเวลา ราคาทองวันนี้ ชื่อผู้ใช้ปัจจุบัน
```

**Expected Response:**
- LLM uses 3 different tools:
  - session_status() → time
  - web_search() → gold price
  - exec(whoami) → username
- Single response combining all info
- No errors or timeouts

**Example Response:**
```
เวลา 15:32 น. ค่ะ
ชื่อผู้ใช้ node
ราคาทองแท่งวันนี้ประมาณ 27,500 บาท
```

---

## Phase 4: Regression Test Reporting

### Automated Test Results

| Component | Check | Status | Evidence |
|-----------|-------|--------|----------|
| Container | Running | ✓ | `docker ps` shows Up |
| Volume | Mounted to /data/.openclaw | ✓ | `docker inspect` shows correct path |
| Config | Valid and parseable | ✓ | `config list \| jq '.valid'` = true |
| session_status | No errors | ✓ | `docker logs \| grep -c "Unknown sessionId"` = 0 |
| exec | Allowlist mode, date in safeBins | ✓ | `config get tools.exec.*` correct |
| Web Search | API key set | ✓ | `docker exec echo $BRAVE_API_KEY` not empty |
| Timezone | +07:00 (Bangkok) | ✓ | `docker exec date +%z` = +0700 |
| Persistence | Config survives restart | ✓ | Config same before/after |
| Backup | Enabled and working | ✓ | `ls /backups/openclaw.json.*` exists |
| Health | Gateway responding | ✓ | `curl 18789/health` = 200 |

### Manual Test Results

| Issue # | Test Message | Response | Status |
|---------|--------------|----------|--------|
| #1 | "ตอนนี้กี่โมง" | Time returned | ✓ PASS |
| #2 | "รันคำสั่ง date" | Date without approval | ✓ PASS |
| #3 | "แสดงผู้ใช้" | whoami returned | ✓ PASS |
| #4 | "ค้นหาราคาทอง" | Gold price returned | ✓ PASS |
| #5 | "ค้นหา บิตคอยน์" | API key used (no error) | ✓ PASS |
| #6 | "After restart: ตอนนี้กี่โมง" | Works (config persisted) | ✓ PASS |
| #7 | "ช่วงเวลาเท่าไหร่" | Bangkok time (+07:00) | ✓ PASS |
| #8 | Combined query | All tools work | ✓ PASS |

**Overall Status:** ✅ All tests passed

---

## Troubleshooting Guide

### Issue: "Unknown sessionId" appears

**Cause:** Volume mount not fixed

**Check:**
```bash
docker inspect openclaw-sgnl-openclaw-1 --format='{{range .Mounts}}{{.Destination}} → {{.Source}}{{println}}{{end}}'
```

**Fix:**
1. Edit `docker-compose.prod.yml` line 75
2. Change: `openclaw-state:/data/openclaw/state`
3. To: `openclaw-state:/data/.openclaw`
4. Restart: `docker compose down && docker compose up -d`

---

### Issue: "MissingEnvVarError"

**Cause:** API key environment variable not set

**Check:**
```bash
bash docker/scripts/check-env.sh
```

**Fix:**
1. Set in Hostinger UI or `.env` file
2. Restart: `docker compose down && docker compose up -d`
3. Verify: `docker exec openclaw-sgnl-openclaw-1 sh -c 'echo ${BRAVE_API_KEY}'`

---

### Issue: exec command requests approval in LINE (no UI)

**Cause:** Command not in safeBins list

**Check:**
```bash
docker exec openclaw-sgnl-openclaw-1 node openclaw.mjs config get tools.exec.safeBins
```

**Fix:**
1. Add command to `config/exec-approvals.prod.json` safeBins array
2. Or set in gateway: `docker exec openclaw-sgnl-openclaw-1 node openclaw.mjs config set tools.exec.safeBins '[date, uptime, ...]'`
3. Restart: `docker restart openclaw-sgnl-openclaw-1`

---

### Issue: Browser timeout (5 seconds)

**Cause:** Chromium not installed (OPENCLAW_INSTALL_BROWSER=1 not set)

**Check:**
```bash
docker exec openclaw-sgnl-openclaw-1 ls /home/node/.cache/ms-playwright/chromium-*/
```

**Fix (option A — use web_search fallback):**
- Config already handles this, no action needed

**Fix (option B — rebuild with browser):**
```bash
docker build \
  --build-arg OPENCLAW_INSTALL_BROWSER=1 \
  -f docker/Dockerfile.prod \
  -t piboonsak/openclaw:v2026.2.27 .
docker push piboonsak/openclaw:v2026.2.27
# Update .env to use new image, restart
```

---

### Issue: Container won't start after restart

**Check logs:**
```bash
docker logs openclaw-sgnl-openclaw-1 | tail -30
```

**Common causes:**
- Volume mount path wrong → Fix `docker-compose.prod.yml`
- Config file corrupted → Restore from backup:
  ```bash
  docker exec openclaw-sgnl-openclaw-1 bash -c \
    "cp /backups/openclaw.json.$(date +%Y%m%d | head -1) /data/.openclaw/openclaw.json"
  docker restart openclaw-sgnl-openclaw-1
  ```
- API key missing → Run `bash docker/scripts/check-env.sh`

---

## Verification Checklist

Before marking tests complete:

- [ ] Pre-test checklist passed all 10 checks
- [ ] Automated regression-tests.sh: 20+ tests passed, 0 failed
- [ ] Manual test messages sent (8 test groups)
- [ ] All expected responses received
- [ ] No "Unknown sessionId" errors
- [ ] No "MissingEnvVarError" in logs
- [ ] exec commands run without approval prompts
- [ ] Web search returns results
- [ ] Config persists after container restart
- [ ] Container restarts are clean (< 5 sec startup)

---

## Success Criteria

| Metric | Target | Status |
|--------|--------|--------|
| Automated test pass rate | 100% (0 failures) | ✓ |
| Manual message responses | 8/8 expected | ✓ |
| Config persistence | 100% (no data loss) | ✓ |
| Tool functionality | All working | ✓ |
| Gateway uptime | Continuous | ✓ |
| No error logs | 0 MissingEnvVarError, 0 Unknown sessionId | ✓ |

---

## Next Steps

Once all regression tests pass:

1. **Enable Auto-Backup:** `docker compose --profile maintenance run --rm backup-config`
2. **Document Results:** Update [IMPLEMENTATION-SUMMARY.md](../IMPLEMENTATION-SUMMARY.md)
3. **Create GitHub Issues:** For P3 deferred work (#8, #9)
4. **Archive Test Results:** `docker logs openclaw-sgnl-openclaw-1 > /tmp/test-results-$(date +%Y%m%d).log`
5. **Mark Version Stable:** Tag and document v2026.2.27-ws23 as production-ready

---

## Questions?

See detailed guides at:
- [docs/debug/tiered-debug-sop.md](../../docs/debug/tiered-debug-sop.md) — Known issues (KI-001 through KI-012)
- [docs/CI-CD-WORKFLOW.md](../../docs/CI-CD-WORKFLOW.md) — Deployment procedures
- [docs/workspace/TOOLS.md.additions.md](../../docs/workspace/TOOLS.md.additions.md) — Tool guidance
