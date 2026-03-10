---
name: pattern-detector
description: "Prepend sender identity and pattern alerts before the agent starts"
homepage: https://docs.openclaw.ai/automation/hooks
metadata:
  {
    "openclaw":
      {
        "emoji": "🔎",
        "events": ["before_agent_start"],
        "metadataOnly": true,
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Pattern Detector Hook

Builds extra prompt context before the agent runs by combining sender identification,
inbound pattern matches, and queued outbound alerts.

## What It Does

1. Runs `sender-check` first so sender context is prepended before any pattern alert
2. Extracts sender metadata from prompt envelope blocks when upstream did not populate it
3. Scans inbound text with configurable regex patterns
4. Drains pending outbound alerts and suppresses duplicates with a cooldown window

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "pattern-detector": {
          "enabled": true,
          "outboundCooldownMinutes": 5,
          "patterns": [],
          "senderCheck": {
            "enabled": true,
            "ownerNumbers": ["+15551234567"],
            "briefingFile": "memory/system/contacts-briefing.json",
            "maxBriefingChars": 800,
            "debounceMinutes": 15,
            "knownTemplate": "KNOWN {{senderName}} ({{senderNumber}})",
            "unknownTemplate": "UNKNOWN {{senderName}} ({{senderNumber}})"
          }
        }
      }
    }
  }
}
```

## Notes

- This metadata entry is documentation-only for the Iris typed hook registration.
- Companion API and UI routes for pattern management are registered separately under `/__iris__/patterns*`.
