---
name: scanblitz
description: "Create trackable QR codes and get scan analytics via the ScanBlitz API. Use when: user wants to generate QR codes, track scans, manage dynamic QR destinations, or view QR analytics. NOT for: generating static QR images without tracking, barcode scanning, or reading QR codes from images."
homepage: https://scanblitz.com
metadata:
  {
    "openclaw":
      {
        "emoji": "📱",
        "requires": { "env": ["SCANBLITZ_API_KEY"], "bins": ["curl"] },
        "primaryEnv": "SCANBLITZ_API_KEY",
      },
  }
---

# ScanBlitz — QR Codes & Analytics

Create trackable QR codes, update destinations on the fly, and pull real-time scan analytics.

## When to Use

✅ **USE this skill when:**

- "Create a QR code for this URL"
- "Make a trackable QR code for our landing page"
- "How many scans did that QR code get?"
- "Update the QR code to point to a new URL"
- "Generate QR codes for all our product pages"
- "Deactivate the old QR code"

## When NOT to Use

❌ **DON'T use this skill when:**

- Generating a static QR image with no tracking → use `qrencode` CLI
- Reading/decoding QR codes from images → use `zbarimg`
- Barcode generation → use a barcode library

## Setup

### Get an API key

**Option A — Self-register (no browser needed):**

```bash
# Step 1: Request verification code
curl -s -X POST "https://kylpeyhiqtdonlqqguty.supabase.co/functions/v1/agent-register" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "agent_name": "OpenClaw Agent"}'

# Step 2: Check email for 6-digit code, then verify
curl -s -X POST "https://kylpeyhiqtdonlqqguty.supabase.co/functions/v1/agent-register/verify" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "code": "123456"}'
# → Returns API key (sbz_partner_... or sb_api_...)
```

**Option B — Web signup:** https://scanblitz.com/auth

### Store the key

```bash
# Add to environment
echo 'SCANBLITZ_API_KEY=your_key_here' >> ~/.config/openclaw/.env
```

## API Basics

All requests use the partner API with an `X-Partner-Key` header (for `sbz_partner_` keys) or `Authorization: Bearer` header (for `sb_api_` keys):

```bash
SCANBLITZ_BASE="https://kylpeyhiqtdonlqqguty.supabase.co/functions/v1/partner-api"

# For partner keys (sbz_partner_...)
AUTH_HEADER="X-Partner-Key: $SCANBLITZ_API_KEY"

# For enterprise keys (sb_api_...)
# AUTH_HEADER="Authorization: Bearer $SCANBLITZ_API_KEY"
```

## Create a QR Code

```bash
curl -s -X POST "$SCANBLITZ_BASE" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "name": "My Landing Page",
    "destination_url": "https://example.com/landing",
    "partner_ref": "openclaw:my-landing"
  }'
```

**Response:**

```json
{
  "qr_code": {
    "id": "uuid",
    "short_id": "xK7mQ3",
    "name": "My Landing Page",
    "destination_url": "https://example.com/landing",
    "scan_url": "https://kylpeyhiqtdonlqqguty.supabase.co/functions/v1/qr-redirect/xK7mQ3",
    "is_active": true
  }
}
```

> **Save the `short_id`** — you need it for analytics, updates, and deletion.

## Get QR Code Details

```bash
curl -s "$SCANBLITZ_BASE/xK7mQ3" \
  -H "$AUTH_HEADER"
```

## Get Scan Analytics

```bash
curl -s "$SCANBLITZ_BASE/analytics/xK7mQ3" \
  -H "$AUTH_HEADER"
```

**Response includes:**

- `total_scans` — total number of scans
- `devices` — breakdown by device type (mobile, desktop, tablet)
- `countries` — breakdown by country
- `daily_scans` — scans per day

## Update Destination

Change where a QR code points without regenerating it:

```bash
curl -s -X PUT "$SCANBLITZ_BASE/xK7mQ3" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "destination_url": "https://example.com/new-page",
    "name": "Updated Landing Page"
  }'
```

## Deactivate a QR Code

Soft-delete — the QR code stops redirecting:

```bash
curl -s -X DELETE "$SCANBLITZ_BASE/xK7mQ3" \
  -H "$AUTH_HEADER"
```

## Health Check

```bash
curl -s "$SCANBLITZ_BASE/health" \
  -H "$AUTH_HEADER"
```

## Quick Reference

| Action | Method | Path | Body |
|--------|--------|------|------|
| Create QR | POST | `/` | `{"name", "destination_url"}` |
| Get QR | GET | `/{short_id}` | — |
| Update QR | PUT | `/{short_id}` | `{"destination_url", "name", "is_active"}` |
| Delete QR | DELETE | `/{short_id}` | — |
| Analytics | GET | `/analytics/{short_id}` | — |
| Health | GET | `/health` | — |

## Free Tier Limits

- 50 QR codes
- 1,000 tracked scans/month
- 5,000 API calls/month
- 7-day analytics retention

Upgrade at https://scanblitz.com/pricing

## Notes

- Every scan is tracked: device type, browser, OS, country, city, referrer, UTM params
- QR codes are dynamic — update the destination anytime without reprinting
- The `scan_url` is what you encode into the actual QR image
- Full API reference for agents: https://scanblitz.com/llms-full.txt
- MCP server also available: `npx -y @scanblitz/mcp-server`
