---
name: affiliate-check
version: 1.0.0
description: |
  Live affiliate program data from list.affitor.com. Search programs, compare commissions,
  check cookie days, find top performers. Use when researching affiliate programs,
  comparing options, or checking program details. Persistent daemon with cache — first call
  starts server (~2s), subsequent calls ~100ms.
allowed-tools:
  - Bash
  - Read
---

# affiliate-check: Live Affiliate Program Data

Query affiliate program data from list.affitor.com in real-time. Persistent daemon
with in-memory cache — first call auto-starts the server, every subsequent call is instant.

## SETUP (run this check BEFORE any affiliate-check command)

Before using any command, find the skill and check if the binary exists:

```bash
# Check project-level first, then user-level
if test -x .claude/skills/affiliate-skills/tools/dist/affiliate-check; then
  A=.claude/skills/affiliate-skills/tools/dist/affiliate-check
elif test -x ~/.claude/skills/affiliate-skills/tools/dist/affiliate-check; then
  A=~/.claude/skills/affiliate-skills/tools/dist/affiliate-check
else
  echo "NEEDS_SETUP"
fi
```

Set `A` to whichever path exists and use it for all commands.

If `NEEDS_SETUP`:

1. Tell the user: "affiliate-check needs a one-time build (~10 seconds). OK to proceed?"
2. If approved, run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

## Quick Reference

```bash
A=~/.claude/skills/affiliate-skills/tools/dist/affiliate-check

# Search programs
$A search "AI video tools"
$A search --recurring --tags ai

# Top programs
$A top
$A top --sort trending

# Program details
$A info heygen

# Compare programs side-by-side
$A compare heygen synthesia

# Server management
$A status
$A stop
```

## Commands

### Search

```
affiliate-check search <query>                    Search by name/keyword
affiliate-check search --recurring                Filter recurring commissions
affiliate-check search --tags ai,video            Filter by tags
affiliate-check search --min-cookie 30            Min cookie days
affiliate-check search --sort new                 Sort: trending | new | top
affiliate-check search --limit 20                 Result limit
```

### Discovery

```
affiliate-check top                               Top programs by stars
affiliate-check top --sort trending               Trending programs
affiliate-check top --sort new                    Newest programs
```

### Details

```
affiliate-check info <name>                       Detailed program card
affiliate-check compare <name1> <name2> [name3]   Side-by-side comparison
```

### Server

```
affiliate-check status                            Uptime, cache, API key status
affiliate-check stop                              Shutdown daemon
affiliate-check help                              Full help
```

## Environment

```
AFFITOR_API_KEY    Optional. API key from list.affitor.com
                   Without: free tier (max 5 results per query)
                   With: unlimited access
                   Get one: list.affitor.com/settings → API Keys (free)
```

## Architecture

- Persistent Bun daemon on localhost (port 9500-9510)
- In-memory cache with 5-minute TTL
- State file: `/tmp/affiliate-check.json`
- Auto-shutdown after 30 min idle
- Server crash → auto-restarts on next command
