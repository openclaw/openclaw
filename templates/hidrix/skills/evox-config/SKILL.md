---
name: evox-config
description: Guide về EVOX.sh configuration. Use when user asks about cron, config files, or EVOX.sh setup.
---

# evox-config

EVOX.sh configuration guide. Use this when explaining cron, config, or agent setup.

## ⚠️ IMPORTANT: Path Names

**CORRECT paths:**
- `~/.evox/evox.yaml` — Main config (NOT `~/.openclaw/config.yaml`)
- `~/.evox/agents/main/` — Agent data
- `/workspace/` — Trong Docker container

**DEPRECATED (không dùng):**
- ~~`~/.openclaw/`~~ → Dùng `~/.evox/`
- ~~`openclaw.mjs`~~ → Dùng `evox`

## Cron System

```
EVOX.sh Cron System
- Không phải system cron (crontab)
- Managed bởi EVOX.sh gateway
- Config trong ~/.evox/evox.yaml
- Mỗi job = 1 isolated session
```

### Config example
```yaml
# ~/.evox/evox.yaml
cron:
  jobs:
    - name: daily-report
      schedule: "0 9 * * *"  # 9 AM daily
      prompt: "Generate daily summary"
```

### Cron expressions
- `* * * * *` = minute hour day month weekday
- `0 9 * * *` = 9:00 AM daily
- `0 */4 * * *` = every 4 hours
- `0 9 * * 1-5` = 9 AM weekdays

## Common Tasks

### Check config
```bash
cat ~/.evox/evox.yaml
```

### Reload config
```bash
evox gateway reload
```

### View cron jobs
```bash
evox cron list
```
