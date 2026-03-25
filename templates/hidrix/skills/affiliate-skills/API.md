# list.affitor.com API Reference

Public and authenticated access to the Affitor affiliate program directory.

- **Base URL:** `https://list.affitor.com/api/v1`
- **Format:** JSON (unless noted)
- **Last updated:** 2026-03-16

---

## Authentication

API keys are created at `https://list.affitor.com/settings` (requires a free account). Keys need the `programs:read` scope at minimum.

Pass the key in the `Authorization` header:

```
Authorization: Bearer afl_xxxxx
```

**Free tier (no key):** All endpoints work without authentication, but results are capped at **5 per request**. The response will include `"tier": "free"` and a notice message.

---

## Endpoints

### GET /programs

List and search published affiliate programs.

#### Query Parameters

| Parameter         | Type    | Default             | Description                                                                                                |
| ----------------- | ------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `q`               | string  | —                   | Full-text search on name and description (case-insensitive, partial match)                                 |
| `type`            | string  | `affiliate_program` | Filter by type: `affiliate_program` or `skill`                                                             |
| `sort`            | string  | `trending`          | Sort order: `trending`, `new`, or `top`                                                                    |
| `limit`           | integer | `30`                | Results per page. Maximum: `100`. Free tier: max `5`.                                                      |
| `offset`          | integer | `0`                 | Pagination offset                                                                                          |
| `reward_type`     | string  | —                   | Filter by reward structure (see Reward Types below)                                                        |
| `tags`            | string  | —                   | Comma-separated tags to filter by. Matches programs tagged with ANY of the given tags. Example: `ai,video` |
| `min_cookie_days` | integer | —                   | Minimum cookie duration in days                                                                            |

All parameters can be combined. Example — search for recurring AI tools with a 30-day minimum cookie:

```
GET /api/v1/programs?q=AI&reward_type=cps_recurring&min_cookie_days=30&sort=top&limit=10
```

#### Response

```json
{
  "data": [
    {
      "id": "3f2a1b4c-...",
      "slug": "heygen",
      "name": "HeyGen",
      "url": "https://heygen.com",
      "description": "AI video generation platform. Create studio-quality videos from text.",
      "reward_type": "cps_recurring",
      "reward_value": "30%",
      "reward_duration": "12 months",
      "cookie_days": 60,
      "stars_count": 42,
      "views_count": 1200,
      "comments_count": 5,
      "category": "ai-tools",
      "tags": ["ai", "video"],
      "type": "affiliate_program",
      "stage": null,
      "status": "published",
      "created_at": "2026-01-15T10:00:00.000Z",
      "profiles": {
        "handle": "sonpiaz",
        "avatar_url": "https://...",
        "name": "Son Piaz"
      }
    }
  ],
  "count": 1
}
```

**Free tier response** additionally includes:

```json
{
  "data": [...],
  "count": 5,
  "tier": "free",
  "message": "Free tier: max 5 results. Get an API key at list.affitor.com/settings for unlimited access."
}
```

#### Field Reference

| Field             | Type              | Notes                                                  |
| ----------------- | ----------------- | ------------------------------------------------------ |
| `id`              | string (UUID)     | Unique program identifier                              |
| `slug`            | string            | URL-friendly identifier, e.g. `heygen`                 |
| `name`            | string            | Display name                                           |
| `url`             | string \| null    | Product website                                        |
| `description`     | string            | Program description                                    |
| `reward_type`     | string \| null    | Commission structure (see Reward Types)                |
| `reward_value`    | string \| null    | Commission amount as a string, e.g. `"30%"` or `"$50"` |
| `reward_duration` | string \| null    | Duration of recurring commissions, e.g. `"12 months"`  |
| `cookie_days`     | integer \| null   | Cookie window in days                                  |
| `stars_count`     | integer           | Community star count (popularity signal)               |
| `views_count`     | integer           | Page view count                                        |
| `comments_count`  | integer           | Number of comments                                     |
| `category`        | string \| null    | Top-level category                                     |
| `tags`            | string[] \| null  | Tag array for filtering                                |
| `type`            | string            | `affiliate_program` or `skill`                         |
| `status`          | string            | `published` for visible programs                       |
| `created_at`      | string (ISO 8601) | Submission date                                        |
| `profiles`        | object            | Submitter's public profile                             |

> **Field naming:** Use `reward_value`, `reward_type`, `cookie_days`, and `stars_count` exactly as shown. Do not substitute `commission_rate`, `upvotes`, or `cookie_duration` — those field names do not exist in the schema.

---

### GET /programs/:id

Retrieve a single program by UUID.

**Requires authentication** (`programs:read` scope).

#### Response

Returns the same `Program` object under a `data` key:

```json
{
  "data": { ...program object... }
}
```

Returns `404` if no program is found with the given ID.

---

### GET /skills/:slug/raw

Returns the raw Markdown content of a skill file as `text/plain`.

**Public — no authentication required.**

Example:

```
GET /api/v1/skills/affiliate-program-search/raw
```

---

## Reward Types

| Value           | Meaning                       |
| --------------- | ----------------------------- |
| `cpc`           | Cost per click                |
| `cpl`           | Cost per lead                 |
| `cps_one_time`  | One-time sale commission      |
| `cps_recurring` | Recurring sale commission     |
| `cps_lifetime`  | Lifetime recurring commission |
| `other`         | Non-standard structure        |

---

## Error Responses

| HTTP Status             | Meaning                             |
| ----------------------- | ----------------------------------- |
| `401 Unauthorized`      | API key is invalid or malformed     |
| `403 Forbidden`         | API key lacks `programs:read` scope |
| `404 Not Found`         | Program ID does not exist           |
| `429 Too Many Requests` | Rate limit exceeded                 |

---

## Rate Limits

- **Authenticated:** 60 requests per minute per API key
- **Unauthenticated (free tier):** Lower limits apply; exact threshold not published
- Responses should be cached within a session to avoid redundant requests

---

## Code Examples

### curl

**Search with no API key (free tier):**

```bash
curl "https://list.affitor.com/api/v1/programs?q=AI+video&sort=top&limit=5"
```

**Authenticated search with filters:**

```bash
curl \
  -H "Authorization: Bearer afl_xxxxx" \
  "https://list.affitor.com/api/v1/programs?q=AI&reward_type=cps_recurring&min_cookie_days=30&sort=top&limit=20"
```

**Get a single program:**

```bash
curl \
  -H "Authorization: Bearer afl_xxxxx" \
  "https://list.affitor.com/api/v1/programs/3f2a1b4c-0000-0000-0000-000000000000"
```

---

### JavaScript / fetch

**Search programs:**

```js
async function searchPrograms(query, options = {}) {
  const url = new URL("https://list.affitor.com/api/v1/programs");

  if (query) url.searchParams.set("q", query);
  if (options.rewardType) url.searchParams.set("reward_type", options.rewardType);
  if (options.tags) url.searchParams.set("tags", options.tags.join(","));
  if (options.minCookieDays) url.searchParams.set("min_cookie_days", String(options.minCookieDays));
  if (options.sort) url.searchParams.set("sort", options.sort);
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.offset) url.searchParams.set("offset", String(options.offset));

  const headers = { Accept: "application/json" };
  if (process.env.AFFITOR_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.AFFITOR_API_KEY}`;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  return res.json(); // { data: Program[], count: number, tier?: "free" }
}

// Usage
const result = await searchPrograms("AI video", {
  rewardType: "cps_recurring",
  minCookieDays: 30,
  sort: "top",
  limit: 10,
});

for (const program of result.data) {
  console.log(
    `${program.name} — ${program.reward_value} (${program.reward_type}), ${program.cookie_days}d cookie`,
  );
}
```

**Get a single program by UUID:**

```js
async function getProgram(id) {
  const res = await fetch(`https://list.affitor.com/api/v1/programs/${id}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${process.env.AFFITOR_API_KEY}`,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json();
  return json.data;
}
```

---

## Fallback: Web Scraping

If you do not have an API key or the API is unavailable, program data can be extracted from list.affitor.com pages directly.

**Method:**

1. Search: `site:list.affitor.com [category or keyword]` using a web search tool
2. Fetch the relevant page with a web fetch tool
3. Parse the page content:
   - Program name from the card heading
   - Reward info: look for patterns like `"30% recurring"` or `"$50 one-time"`
   - Cookie duration: look for `"Xd"` or `"X day cookie"`
   - Stars: star icon followed by a number
   - Description: paragraph text below the program name

**Program detail page format:** `https://list.affitor.com/@[handle]/[slug]`

Example: `https://list.affitor.com/@sonpiaz/heygen`

---

## Getting an API Key

1. Sign up (free) at [list.affitor.com](https://list.affitor.com)
2. Go to **Settings → API Keys**
3. Create a key with the `programs:read` scope
4. Set the environment variable: `AFFITOR_API_KEY=afl_xxxxx`

The free tier (no key) supports up to 5 results per request and is suitable for lightweight lookups.
