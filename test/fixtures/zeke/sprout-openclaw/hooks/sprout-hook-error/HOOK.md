---
name: sprout-hook-error
description: "Classify Sprout OpenClaw hook and tool errors."
metadata:
  openclaw:
    emoji: "⚠️"
    events: ["error", "on-error"]
    requires:
      env: ["SPROUT_OPENCLAW_HOOK_TOKEN"]
---

# Sprout Hook Error

Emits `ops:sprout.hook_error` with a short non-secret error summary.
