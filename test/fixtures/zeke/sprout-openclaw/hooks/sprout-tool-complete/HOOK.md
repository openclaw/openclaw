---
name: sprout-tool-complete
description: "Emit Sprout OpenClaw post-tool completion telemetry."
metadata:
  openclaw:
    emoji: "✅"
    events: ["after_tool_call", "post-tool"]
    requires:
      env: ["SPROUT_OPENCLAW_HOOK_TOKEN"]
---

# Sprout Tool Complete

Emits redacted `tool:sprout.call_completed` telemetry after tool execution.
