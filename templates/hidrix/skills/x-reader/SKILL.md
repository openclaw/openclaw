---
name: x-reader
description: Read tweets from X/Twitter without API key. Supports text, author, likes, retweets.
metadata: { "openclaw": { "emoji": "🐦" } }
---

# X/Twitter Reader

Read tweet content using public APIs (no auth required).

## Usage

```bash
python3 tools/x-reader.py <tweet_url>
```

## Example

```bash
python3 tools/x-reader.py "https://x.com/karpathy/status/2036487306585268612"
```

Output:

```json
{
  "method": "syndication",
  "author": "Andrej Karpathy",
  "username": "karpathy",
  "text": "Software horror: litellm PyPI supply chain attack...",
  "created_at": "2026-03-24T16:56:24.000Z",
  "likes": 9341,
  "retweets": 0
}
```

## Methods (tried in order)

1. **syndication** - Twitter's CDN API (most reliable)
2. **fxtwitter** - FXTwitter public API
3. **vxtwitter** - VXTwitter public API

## Supported URLs

- `https://x.com/username/status/123456`
- `https://twitter.com/username/status/123456`

## Fields returned

| Field        | Description   |
| ------------ | ------------- |
| `author`     | Display name  |
| `username`   | @handle       |
| `text`       | Tweet content |
| `created_at` | Timestamp     |
| `likes`      | Like count    |
| `retweets`   | Retweet count |

## Notes

- No API key needed
- Works with public tweets only
- Rate limits are generous (public CDN)
