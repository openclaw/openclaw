---
name: sprout-message-memory
description: "Emit Sprout OpenClaw direct message pairs to ZekeFlow memory."
metadata:
  openclaw:
    emoji: "🌱"
    events: ["message:received", "message:sent"]
    requires:
      env: ["SPROUT_OPENCLAW_HOOK_TOKEN"]
---

# Sprout Message Memory

Pairs inbound Ross content with the next outbound Sprout message for the same
OpenClaw session and emits `sprout:conversation.message_pair` through the
Sprout-only hook ingress.

The handler does not write SQLite, mutate repository files, or control
processes. On failure it emits `ops:sprout.memory_emit_failed` where possible
and then returns without blocking the OpenClaw turn.
