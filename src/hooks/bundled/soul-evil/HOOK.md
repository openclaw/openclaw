---（轉為繁體中文）
name: soul-evil（轉為繁體中文）
description: "Swap SOUL.md with SOUL_EVIL.md during a purge window or by random chance"（轉為繁體中文）
homepage: https://docs.openclaw.ai/hooks/soul-evil（轉為繁體中文）
metadata:（轉為繁體中文）
  {（轉為繁體中文）
    "openclaw":（轉為繁體中文）
      {（轉為繁體中文）
        "emoji": "😈",（轉為繁體中文）
        "events": ["agent:bootstrap"],（轉為繁體中文）
        "requires": { "config": ["hooks.internal.entries.soul-evil.enabled"] },（轉為繁體中文）
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],（轉為繁體中文）
      },（轉為繁體中文）
  }（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
# SOUL Evil Hook（轉為繁體中文）
（轉為繁體中文）
Replaces the injected `SOUL.md` content with `SOUL_EVIL.md` during a daily purge window or by random chance.（轉為繁體中文）
（轉為繁體中文）
## What It Does（轉為繁體中文）
（轉為繁體中文）
When enabled and the trigger conditions match, the hook swaps the **injected** `SOUL.md` content before the system prompt is built. It does **not** modify files on disk.（轉為繁體中文）
（轉為繁體中文）
## Files（轉為繁體中文）
（轉為繁體中文）
- `SOUL.md` — normal persona (always read)（轉為繁體中文）
- `SOUL_EVIL.md` — alternate persona (read only when triggered)（轉為繁體中文）
（轉為繁體中文）
You can change the filename via hook config.（轉為繁體中文）
（轉為繁體中文）
## Configuration（轉為繁體中文）
（轉為繁體中文）
Add this to your config (`~/.openclaw/openclaw.json`):（轉為繁體中文）
（轉為繁體中文）
```json（轉為繁體中文）
{（轉為繁體中文）
  "hooks": {（轉為繁體中文）
    "internal": {（轉為繁體中文）
      "enabled": true,（轉為繁體中文）
      "entries": {（轉為繁體中文）
        "soul-evil": {（轉為繁體中文）
          "enabled": true,（轉為繁體中文）
          "file": "SOUL_EVIL.md",（轉為繁體中文）
          "chance": 0.1,（轉為繁體中文）
          "purge": { "at": "21:00", "duration": "15m" }（轉為繁體中文）
        }（轉為繁體中文）
      }（轉為繁體中文）
    }（轉為繁體中文）
  }（轉為繁體中文）
}（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### Options（轉為繁體中文）
（轉為繁體中文）
- `file` (string): alternate SOUL filename (default: `SOUL_EVIL.md`)（轉為繁體中文）
- `chance` (number 0–1): random chance per run to swap in SOUL_EVIL（轉為繁體中文）
- `purge.at` (HH:mm): daily purge window start time (24h)（轉為繁體中文）
- `purge.duration` (duration): window length (e.g. `30s`, `10m`, `1h`)（轉為繁體中文）
（轉為繁體中文）
**Precedence:** purge window wins over chance.（轉為繁體中文）
（轉為繁體中文）
## Requirements（轉為繁體中文）
（轉為繁體中文）
- `hooks.internal.entries.soul-evil.enabled` must be set to `true`（轉為繁體中文）
（轉為繁體中文）
## Enable（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks enable soul-evil（轉為繁體中文）
```（轉為繁體中文）
