#!/bin/bash
# Regression Test Messages for LINE Bot
# These messages test all 9 issues via actual LINE channel interactions
# Usage: Send each message to the LINE bot and verify the response

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cat << 'EOF'
╔════════════════════════════════════════════════════════════════════════════╗
║        OpenClaw LINE Bot - Regression Test Messages (v2026.2.27-ws23+)    ║
║                    Send each message to the bot and verify response        ║
╚════════════════════════════════════════════════════════════════════════════╝

TEST GROUP 1: Issue #1, #5, #6 — Volume Persistence & session_status
═══════════════════════════════════════════════════════════════════════════════

Message 1A (Thai):
  ตอนนี้กี่โมงแล้วครับ

  Expected Response:
    • Returns current time (e.g., "เวลา 15:32 น. ค่ะ")
    • No "Unknown sessionId" error
    • Timestamp should match actual server time (+07:00 Bangkok)

Message 1B (Thai):
  ใช้โมเดลไหน

  Expected Response:
    • Shows current model name and provider
    • No errors
    • Example: "ใช้ Gemini 2.5 Flash ค่ะ"

Verification:
  ✓ KI-009: Volume mounted to /data/.openclaw/
  ✓ Config/sessions persist across restarts
  ✓ session_status() tool works in LINE session


TEST GROUP 2: Issue #2 — exec date approval loop  
═══════════════════════════════════════════════════════════════════════════════

Message 2A (Thai):
  รันคำสั่ง date

  Expected Response:
    • No approval prompt (date is pre-approved)
    • Returns current date/time
    • Example: "Tue Feb 17 15:32:45 +07 2026"

Message 2B (Thai):
  บอกเวลาปัจจุบันด้วยคำสั่ง

  Expected Response:
    • Recognizes request for time via exec
    • Runs safely without approval loop
    • Returns accurate time

Verification:
  ✓ KI-002: date in tools.exec.safeBins
  ✓ No approval UI prompts (LINE has no approval UI)
  ✓ Pre-approved commands run immediately


TEST GROUP 3: Issue #3 — exec host not allowed
═══════════════════════════════════════════════════════════════════════════════

Message 3A (Thai):
  แสดงผู้ใช้ปัจจุบัน

  Expected Response:
    • Can execute on gateway host
    • Returns username (e.g., "node" or "root")
    • No "host not allowed" error

Message 3B (Thai):
  รันคำสั่ง whoami

  Expected Response:
    • Returns user running the container
    • No host mismatch errors

Verification:
  ✓ KI-010: tools.exec.host = "gateway"
  ✓ LLM no longer requests sandbox (not available on VPS)
  ✓ exec tool works with gateway host


TEST GROUP 4: Issue #4 — Browser service
═══════════════════════════════════════════════════════════════════════════════

Message 4A (Thai):
  ดึงข้อมูลจาก https://example.com

  Expected Response (with browser):
    • Page content extracted (screenshot/text)
    • No "Can't reach the OpenClaw browser control service"
    
  Expected Response (without browser):
    • Gracefully falls back to web_search()
    • Returns related information from search
    • Bot mentions: "ไม่สามารถดึงข้อมูลแบบเรียลไทม์"

Message 4B (Thai):
  ค้นหาราคาทองวันนี้

  Expected Response:
    • Uses web_search (Brave API) as fallback
    • Returns current gold price
    • No timeout errors

Verification:
  ✓ KI-011: Browser available (if OPENCLAW_INSTALL_BROWSER=1) OR
  ✓ Gracefully falls back to web_search
  ✓ No 5-second timeout in gateway logs


TEST GROUP 5: Issue #5 — Brave API key persistence
═══════════════════════════════════════════════════════════════════════════════

Message 5A (Thai):
  ค้นหา "ราคาเงิน" วันนี้

  Expected Response:
    • web_search returns results for silver price
    • Bot provides current market data
    • No MissingEnvVarError

Message 5B (Thai):
  ค้นหาข่าวไทยล่าสุด 3 ข่าว

  Expected Response:
    • Returns top 3 news results
    • BRAVE_API_KEY successfully resolved from env
    • No empty API key errors

Verification:
  ✓ KI-009: Config persists across restarts
  ✓ KI-012: ${BRAVE_API_KEY} env var resolved
  ✓ API key not lost on container restart
  ✓ check-env.sh pre-deployment validation passes


TEST GROUP 6: Issue #6 — Embeddings/config persistence
═══════════════════════════════════════════════════════════════════════════════

Message 6 (Verification):
  [Restart container on VPS]
  $ docker restart openclaw-sgnl-openclaw-1
  [Wait 15 seconds]
  
  [Send to bot again]:
  ตอนนี้กี่โมงแล้ว

  Expected Response:
    • Bot still works after restart
    • Config and sessions recovered from volume
    • No "Unknown sessionId" error

Verification:
  ✓ KI-009: /data/.openclaw/ on named volume openclaw-state
  ✓ Embeddings config persists
  ✓ No data loss on container restart


TEST GROUP 7: Issue #7 — Docker time sync
═══════════════════════════════════════════════════════════════════════════════

Message 7A (Thai):
  ช่วงเวลาเท่าไหร่

  Expected Response:
    • Returns time in Bangkok timezone (+07:00)
    • Matches actual server time
    • Example: "เวลา 15:32:45 +0700"

Message 7B:
  [Verification on VPS]:
  $ date  # Host: UTC+0
  $ docker exec openclaw-sgnl-openclaw-1 date  # Container: UTC+7
  
  Expected Output:
    • Container shows +0700 (correct)
    • No 24-hour offset
    • Time synchronized (within 5 seconds)

Verification:
  ✓ KI-007: Container TZ=Asia/Bangkok correctly set
  ✓ No time sync issues
  ✓ Timestamp handling correct in all tools


TEST GROUP 8: Combined Workflow Test
═══════════════════════════════════════════════════════════════════════════════

Message 8 (Thai):
  ตอนนี้กี่โมง ราคาทอง เท่าไหร่ และบอกผู้ใช้ปัจจุบัน

  Expected Response:
    • Uses session_status() for time
    • Uses web_search() for gold price  
    • Uses exec(whoami) for username
    • All tools work together
    • No errors or timeouts

Example: "เวลา 15:32 น. ค่ะ ตัวเองคือ node ราคาทองแท่งวันนี้ 27,500 บาท"

Verification:
  ✓ All issue fixes working together
  ✓ No single point of failure
  ✓ Tool chaining works reliably


═══════════════════════════════════════════════════════════════════════════════

AUTOMATED VERIFICATION (Run on VPS):
═══════════════════════════════════════════════════════════════════════════════

$ bash tests/regression-tests.sh

This script verifies:
  ✓ Container running with correct volume mounts
  ✓ session_status markers persisted
  ✓ Config valid and timestamp accuracy
  ✓ exec safeBins configured
  ✓ Environment variables set
  ✓ Container restart persistence
  ✓ No MissingEnvVarError in logs

Expected Output:
  Passed: 20+ / 20+
  Failed: 0 / 20+

If any test fails:
  1. Check gateway logs: docker logs --since=10m openclaw-sgnl-openclaw-1
  2. Run: bash docker/scripts/check-env.sh (verify all API keys)
  3. Verify volume mount: docker inspect openclaw-sgnl-openclaw-1 | grep -A5 Mounts


─────────────────────────────────────────────────────────────────────────────

MANUAL VERIFICATION CHECKLIST:

[ ] Message 1A: time query works (no Unknown sessionId)
[ ] Message 1B: model info works
[ ] Message 2A: exec date runs without approval
[ ] Message 2B: date command approved immediately
[ ] Message 3A: whoami works on gateway host
[ ] Message 3B: no "host not allowed" errors
[ ] Message 4A/4B: web_search or browser works
[ ] Message 5A/5B: BRAVE_API_KEY resolved
[ ] Message 6: Config persists after restart
[ ] Message 7A: Time in Bangkok timezone
[ ] Message 7B: Container/host time sync correct
[ ] Message 8: Combined workflow uses all tools
[ ] regression-tests.sh passes completely


═════════════════════════════════════════════════════════════════════════════════

ROLLBACK PROCEDURE (if regression tests fail):

1. Check for data loss:
   docker exec openclaw-sgnl-openclaw-1 cat /backups/openclaw.json.* | head -c 100

2. Restore from backup (if needed):
   docker exec openclaw-sgnl-openclaw-1 bash -c \
     "cp /backups/openclaw.json.$(date +%Y%m%d) /data/.openclaw/openclaw.json"

3. Verify config is valid:
   docker exec openclaw-sgnl-openclaw-1 node openclaw.mjs config list | jq '.valid'

4. Restart container:
   docker restart openclaw-sgnl-openclaw-1

5. Re-run regression tests
   bash tests/regression-tests.sh

═════════════════════════════════════════════════════════════════════════════════
EOF
