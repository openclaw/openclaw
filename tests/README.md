---
title: Testing Suite Summary
description: Quick reference for all regression test files
---

# Testing Suite Summary

**All regression tests created and ready for v2026.2.27-ws23+ deployment**

---

## Files Overview

### 1. [REGRESSION-TESTING.md](REGRESSION-TESTING.md) — Main Testing Guide

**Purpose:** Complete step-by-step testing procedure  
**Sections:**
- Quick start (5-10 min overview)
- Phase 1: Pre-deployment verification
- Phase 2: Automated regression tests
- Phase 3: Manual LINE message testing
- Phase 4: Regression test reporting
- Troubleshooting guide

**When to use:** Starting point for the entire test suite

---

### 2. [pre-test-checklist.sh](pre-test-checklist.sh) — Environment Validation

**Purpose:** Verify VPS is ready before running tests  
**Checks (10 items):**
1. Container running
2. Volume mounts correct
3. Config files exist
4. Environment variables set
5. Tools configured
6. Gateway health
7. Error logs
8. LINE integration
9. Session store
10. Backup status

**Usage:**
```bash
bash tests/pre-test-checklist.sh
```

**Expected output:** `All checks passed! Ready to run regression tests.`

**Time:** 2-3 minutes

---

### 3. [regression-tests.sh](regression-tests.sh) — Automated Test Suite

**Purpose:** Programmatically verify all 9 fixes  
**Coverage:**
- KI-009: Volume mount path (issues #1, #5, #6)
- KI-002: exec safeBins (issue #2)
- KI-010: exec host=gateway (issue #3)
- KI-011: Browser or fallback (issue #4)
- KI-012: Environment variables (issue #5)
- KI-009: Config persistence (issue #6)
- KI-007: Timezone +07:00 (issue #7)
- Gateway health checks
- Config validity checks
- Persistence across restarts

**Usage:**
```bash
bash tests/regression-tests.sh
```

**Expected output:**
```
Passed: 20+ / 20+
Failed: 0 / 20+
✓ All regression tests passed!
```

**Time:** 5-10 minutes

---

### 4. [LINE-REGRESSION-MESSAGES.md](LINE-REGRESSION-MESSAGES.md) — Manual Test Messages

**Purpose:** Test messages to send to LINE bot  
**Groups (8 test groups):**
1. session_status & persistence (issues #1, #5, #6)
2. exec date approval (issue #2)
3. exec host=gateway (issue #3)
4. Browser/web_search (issue #4)
5. API key persistence (issue #5)
6. Config persistence after restart (issue #6)
7. Timezone handling (issue #7)
8. Combined workflow (all tools)

**Test Messages (Thai):**
- "ตอนนี้กี่โมงแล้วครับ" → time check (session_status)
- "รันคำสั่ง date" → exec without approval
- "แสดงผู้ใช้ปัจจุบัน" → whoami on gateway
- "ค้นหาราคาทองวันนี้" → web_search with API key
- "ตอนนี้ราคาทอง ช่วงเวลา ชื่อผู้ใช้" → combined (all tools)

**Usage:** Send each message to LINE bot, verify response matches expectations

**Time:** 10-15 minutes

---

### 5. [tools.md.additions.md](../workspace/TOOLS.md.additions.md) — Workspace Guidance

**Purpose:** Tool usage guide for workspace TOOLS.md  
**Sections:**
- session_status (works in LINE, use for time queries)
- exec (allowlist mode, pre-approved safe commands)
- browser (fallback to web_search)
- web_search (Brave API)
- Limits & constraints table
- Multi-agent scheduling
- Debugging checklist

**Usage:** Append to `/data/.openclaw/workspace/TOOLS.md` during first deployment
```bash
docker exec openclaw-sgnl-openclaw-1 cat /data/.openclaw/workspace/TOOLS.md \
  docs/workspace/TOOLS.md.additions.md > /tmp/TOOLS-new.md && \
  docker exec openclaw-sgnl-openclaw-1 cp /tmp/TOOLS-new.md /data/.openclaw/workspace/TOOLS.md
```

---

## Testing Workflow

### Complete Test Sequence

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: SSH to VPS                                          │
│ ssh root@76.13.210.250                                      │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Step 2: Environment Check (2 min)                           │
│ bash docker/scripts/check-env.sh                            │
│ → Verifies all API keys set                                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Step 3: Pre-Test Checklist (3 min)                          │
│ bash tests/pre-test-checklist.sh                            │
│ → Verifies container, volumes, config, health              │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Step 4: Automated Regression Suite (7 min)                  │
│ bash tests/regression-tests.sh                              │
│ → 20+ automated tests covering all 9 issues                │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Step 5: Manual LINE Testing (10 min)                        │
│ Send test messages from LINE-REGRESSION-MESSAGES.md         │
│ → Verify each response matches expectations                │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Step 6: Result Verification (2 min)                         │
│ All checks passed?                                          │
│ YES → Proceed to release                                    │
│ NO → Review troubleshooting guide                           │
└─────────────────────────────────────────────────────────────┘

Total Time: ~15-20 minutes
```

---

## Expected Results

### Automated Tests (regression-tests.sh)

| Component | Target | Expected |
|-----------|--------|----------|
| Pass Rate | 100% | 20+/20+ ✓ |
| Failures | 0 | 0 ✓ |
| KI-009 checks | 3/3 | ✓ ✓ ✓ |
| Config valid | Yes | ✓ |
| Timezone | +0700 | ✓ |
| Environment | Complete | ✓ |
| Health check | 200 | ✓ |

### Manual Tests (LINE messages)

| Test Group | Messages | Status |
|-----------|----------|--------|
| #1 session_status | 2 | ✓ |
| #2 exec date | 2 | ✓ |
| #3 exec host | 2 | ✓ |
| #4 browser/web_search | 2 | ✓ |
| #5 API key | 2 | ✓ |
| #6 persistence | 1 | ✓ |
| #7 timezone | 1 | ✓ |
| #8 combined | 1 | ✓ |
| **Total** | **13 messages** | **✓** |

---

## Common Test Failures & Fixes

| Failure | Cause | Fix |
|---------|-------|-----|
| "Unknown sessionId" | Volume wrong | See REGRESSION-TESTING.md §Troubleshooting |
| MissingEnvVarError | API key not set | `bash docker/scripts/check-env.sh` |
| exec approval prompt | Command not in safeBins | Add to `tools.exec.safeBins` in config |
| Browser timeout | Chromium not installed | Use web_search fallback (automatic) |
| Config not persisting | Volume mount wrong | Verify line 75 in docker-compose.prod.yml |
| Tests all failing | Container not running | `docker compose up -d` |

---

## Key Issues Covered

| Issue | Root Cause | Test Coverage | Status |
|-------|-----------|---|--------|
| #1 session_status Unknown sessionId | Volume path mismatch | KI-009 checks (3) | ✓ |
| #2 exec date approval loop | date not in safeBins | KI-002 checks (5) | ✓ |
| #3 exec host not allowed | host=sandbox requested | KI-010 checks (2) | ✓ |
| #4 Browser service unreachable | OPENCLAW_INSTALL_BROWSER missing | KI-011 check (1) | ✓ |
| #5 Brave API key disappears | Volume mount + env var | KI-012 checks (2) | ✓ |
| #6 Embeddings lost | Volume mount wrong | KI-009 checks (3) | ✓ |
| #7 Docker time sync | Intended timezone diff | KI-007 checks (2) | ✓ |
| #8 Reply context | Architectural limit | P3 (deferred) | – |
| #9 Auto memory | No skill available | P3 (deferred) | – |

---

## After All Tests Pass

1. **Document Results**
   - Export test logs: `docker logs openclaw-sgnl-openclaw-1 > test-results.log`
   - Note any warnings or observations

2. **Create Release Notes**
   - Update `CHANGELOG.md` with fix descriptions
   - Reference KI-009 through KI-012 in docs

3. **Tag & Commit**
   - Commit: `git commit -am "test: add comprehensive regression suite (v2026.2.27-ws23+)"`
   - Tag: `git tag -a v2026.2.27-ws23-tests -m "Regression test suite"`

4. **Defer P3 Issues**
   - Create GitHub issues for #8 (reply context) and #9 (auto memory)
   - Reference in `docs/debug/tiered-debug-sop.md`

5. **Archive & Handoff**
   - Save test results for compliance/audit
   - Communicate to stakeholders: "v2026.2.27-ws23+ is production-ready"

---

## Quick Commands

```bash
# Full test sequence (one command)
cd /docker/openclaw-sgnl && \
  bash docker/scripts/check-env.sh && \
  bash tests/pre-test-checklist.sh && \
  bash tests/regression-tests.sh

# Check specific issue
docker exec openclaw-sgnl-openclaw-1 \
  node openclaw.mjs config get tools.exec.host  # Issue #3

# View recent errors
docker logs --since=5m openclaw-sgnl-openclaw-1 2>&1 | \
  grep -i "error\|unknown\|missing"

# Verify config persistence
docker exec openclaw-sgnl-openclaw-1 \
  cat /data/.openclaw/openclaw.json | jq '.tools.web.search.apiKey'

# Test container restart
docker restart openclaw-sgnl-openclaw-1
sleep 15
docker logs --tail=20 openclaw-sgnl-openclaw-1

# Create backup before testing
docker compose --profile maintenance run --rm backup-config
```

---

## References

- **Main Guide:** [REGRESSION-TESTING.md](REGRESSION-TESTING.md)
- **Known Issues:** [docs/debug/tiered-debug-sop.md](../../docs/debug/tiered-debug-sop.md)
- **Deployment:** [docs/CI-CD-WORKFLOW.md](../../docs/CI-CD-WORKFLOW.md)
- **Tools Reference:** [docs/workspace/TOOLS.md.additions.md](../workspace/TOOLS.md.additions.md)
- **Implementation Details:** [IMPLEMENTATION-SUMMARY.md](../../IMPLEMENTATION-SUMMARY.md)
