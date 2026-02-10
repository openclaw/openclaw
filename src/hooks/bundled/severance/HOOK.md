---
name: severance
description: "Split your agent into two isolated personas — innie (work) and outie (personal)"
homepage: https://docs.openclaw.ai/hooks/severance
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["hooks.internal.entries.severance.enabled"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Severance Hook

Splits your agent into two isolated personas — **innie** (work) and **outie** (personal) — with separate SOUL and MEMORY files. Inspired by the Lumon Industries severance procedure.

## What It Does

When enabled, the hook replaces the **injected** `SOUL.md` and `MEMORY.md` content with persona-specific files at bootstrap time. It does **not** modify files on disk.

- **Innie**: Loads `SOUL.innie.md` + `MEMORY.innie.md` (work persona)
- **Outie**: Loads `SOUL.outie.md` + `MEMORY.outie.md` (personal persona)

Which persona activates is determined by the configured activation mode.

## Files

- `SOUL.md` — always read first (replaced by the active persona's file)
- `SOUL.innie.md` — work persona
- `SOUL.outie.md` — personal persona
- `MEMORY.innie.md` — work memory
- `MEMORY.outie.md` — personal memory

You can change filenames via hook config (`files`).

## Configuration

Add this to your config (`~/.openclaw/openclaw.json`):

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "severance": {
          "enabled": true,
          "activation": {
            "mode": "schedule",
            "schedule": {
              "workHours": { "start": "09:00", "end": "17:00" },
              "workDays": [1, 2, 3, 4, 5]
            }
          }
        }
      }
    }
  }
}
```

### Activation Modes

- **schedule**: Innie during work hours on work days, outie otherwise. Timezone-aware.
- **channel**: Innie on specified channels (e.g., `slack`, `msteams`), outie on others.
- **env**: Reads an environment variable to decide (e.g., set by iOS Shortcuts or Tasker geofence).
- **manual**: Explicitly set `persona: "innie"` or `"outie"`.
- **location**: Geofence — innie within a radius of configured coordinates, outie outside. Reads from `~/.openclaw/node-location-state.json` (updated by Node companion apps).

### Options

- `activation.mode` (string): `schedule` | `channel` | `env` | `manual` | `location`
- `activation.schedule.workHours` (object): `{ start: "HH:mm", end: "HH:mm" }`
- `activation.schedule.workDays` (number[]): 0=Sun, 1=Mon, ..., 6=Sat (default: `[1,2,3,4,5]`)
- `activation.channels.innie` (string[]): channel names that trigger innie
- `activation.env.var` (string): environment variable name
- `activation.env.innieValue` (string): value that triggers innie (default: `"innie"`)
- `activation.persona` (string): `"innie"` | `"outie"` (for manual mode)
- `activation.location.lat` (number): work latitude
- `activation.location.lon` (number): work longitude
- `activation.location.radiusKm` (number): geofence radius in km
- `files.soulInnie` (string): custom innie soul filename (default: `SOUL.innie.md`)
- `files.soulOutie` (string): custom outie soul filename (default: `SOUL.outie.md`)
- `files.memoryInnie` (string): custom innie memory filename (default: `MEMORY.innie.md`)
- `files.memoryOutie` (string): custom outie memory filename (default: `MEMORY.outie.md`)

## Requirements

- `hooks.internal.entries.severance.enabled` must be set to `true`
- Persona-specific workspace files must exist (e.g., `SOUL.innie.md`)

## Enable

```bash
openclaw hooks enable severance
```
