---
name: message-filter
description: "Filter out automated/junk inbound messages (OTP codes, marketing, reminders, etc.)"
homepage: https://docs.openclaw.ai/hooks#message-filter
metadata:
  {
    "openclaw":
      {
        "emoji": "🚫",
        "events": ["message:inbound"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Message Filter Hook

Silently filters out automated/junk inbound messages so the AI agent doesn't waste tokens responding to OTP codes, marketing texts, appointment reminders, and similar automated notifications.

## What It Does

When an inbound message arrives (after deduplication, before model work):

1. **Checks opt-in** - Does nothing unless explicitly enabled in config
2. **Command bypass** - Never filters messages starting with `/`
3. **Allowed senders bypass** - Never filters messages from allowed senders
4. **Blocked senders** - Always filters messages from blocked senders
5. **Category matching** - Tests message body against regex patterns for 6 built-in categories
6. **Custom patterns** - Tests against user-defined regex patterns
7. **Sets skip flag** - If matched, sets `skip=true` on the hook context so the dispatcher drops the message

## Built-in Categories

| Category       | Examples                                  |
| -------------- | ----------------------------------------- |
| `otp`          | Verification codes, 2FA, PINs             |
| `marketing`    | "Reply STOP", promos, coupons, % off      |
| `appointments` | Doctor/dentist reminders, confirm reply   |
| `fitness`      | Gym class, workout reminders              |
| `delivery`     | Package shipped/delivered, tracking       |
| `banking`      | Transaction alerts, balance notifications |

All categories are enabled by default. Disable individual categories via config.

## Configuration

This hook is **opt-in only**. Add to `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "message-filter": {
          "enabled": true
        }
      }
    }
  }
}
```

### Full Configuration

| Option             | Type     | Default    | Description                               |
| ------------------ | -------- | ---------- | ----------------------------------------- |
| `enabled`          | boolean  | `false`    | Must be `true` to activate                |
| `categories`       | object   | all `true` | Enable/disable built-in categories        |
| `customPatterns`   | string[] | `[]`       | Additional regex patterns to match        |
| `blockedSenders`   | string[] | `[]`       | Always filter messages from these senders |
| `allowedSenders`   | string[] | `[]`       | Never filter messages from these senders  |
| `filterShortcodes` | boolean  | `true`     | Filter 5-6 digit shortcode senders        |
| `logBody`          | boolean  | `false`    | Log redacted message body at debug level  |

### Example with all options

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "message-filter": {
          "enabled": true,
          "categories": {
            "otp": true,
            "marketing": true,
            "appointments": true,
            "fitness": true,
            "delivery": true,
            "banking": true
          },
          "customPatterns": ["prescription .* is ready"],
          "blockedSenders": ["22395"],
          "allowedSenders": ["+14046637573"],
          "logBody": false
        }
      }
    }
  }
}
```

## Logging

By default, only metadata is logged (channel, senderId, messageId, skipReason) at debug level. Message body is **never** logged unless `logBody: true`, in which case digits are redacted.

## Disabling

Remove the entry or set `enabled: false`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "message-filter": { "enabled": false }
      }
    }
  }
}
```
