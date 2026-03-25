# list.affitor.com Data Access

## Current State (as of 2026-03-15)

list.affitor.com runs on Next.js + Supabase. Programs are stored in the `programs` table.

## Method 1: API v1 (preferred, requires API key)

Base URL: `https://list.affitor.com/api/v1`

Authentication: API key in header

```
Authorization: Bearer afl_xxxxx
```

API keys are created at list.affitor.com/settings (requires login). Keys need `programs:read` scope minimum.

### GET /api/v1/programs

Lists published programs and skills.

Query params:

```
type=affiliate_program    Filter by type (affiliate_program | skill)
sort=trending             Sort: trending (default) | new | top
limit=30                  Results per page (default 30, max 100)
offset=0                  Pagination offset
q=search_term             Search name + description (ilike)
reward_type=cps_recurring Filter by reward type
tags=ai,video             Filter by tags (match ANY)
min_cookie_days=30        Minimum cookie duration in days
```

All params are live. Use `q`, `reward_type`, `tags`, `min_cookie_days` together for precise filtering.

Response format:

```json
{
  "data": [
    {
      "id": "uuid",
      "slug": "heygen",
      "name": "HeyGen",
      "url": "https://heygen.com",
      "description": "AI video generation platform...",
      "reward_type": "cps_recurring",
      "reward_value": "30%",
      "reward_duration": "12 months",
      "cookie_days": 60,
      "stars_count": 42,
      "views_count": 1200,
      "comments_count": 5,
      "tags": ["ai", "video"],
      "type": "affiliate_program",
      "source": "user",
      "created_at": "2026-01-15T...",
      "updated_at": "2026-01-15T...",
      "profiles": {
        "handle": "sonpiaz",
        "avatar_url": "...",
        "name": "Son Piaz"
      }
    }
  ],
  "count": 30
}
```

### RewardType values

```
cpc             Cost per click
cpl             Cost per lead
cps_one_time    Cost per sale, one-time
cps_recurring   Cost per sale, recurring
cps_lifetime    Cost per sale, lifetime
other           Other commission structure
```

### GET /api/v1/programs/:id

Returns a single program by UUID. Requires `programs:read` scope.

### GET /api/v1/skills/:slug/raw (PUBLIC, no auth)

Returns raw skill content as `text/plain`. This is the public install endpoint.

## Method 2: Web Fetch (fallback, no auth needed)

Use this if the user doesn't have an API key or if the API returns errors.

1. `web_search`: `site:list.affitor.com [user's category/keyword]`
2. `web_fetch`: the relevant list.affitor.com URL
3. Parse the page content to extract program data:
   - Program name
   - Reward value and type (look for patterns like "30% recurring")
   - Cookie days (look for "Xd" or "X day cookie")
   - Stars count (star icon + number)
   - Description text

Parsing notes:

- Programs are sorted by trending score (engagement / age) by default
- Each program card shows: name, reward info, cookie days, description, stars
- Programs and Skills are separate tabs/sections
- Program detail pages: `list.affitor.com/@[handle]/[slug]`

## Rate Limits

- Cache results within a conversation — don't re-fetch for the same query
- If fetching a full page, extract only relevant programs
- Prefer API when available (structured data, fewer tokens)
- API rate limit: 60 requests/minute per key
