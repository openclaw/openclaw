---
name: sprout-tool-attempt
description: "Emit and enforce Sprout OpenClaw pre-tool telemetry."
metadata:
  openclaw:
    emoji: "🧰"
    events: ["before_tool_call", "pre-tool"]
    requires:
      env: ["SPROUT_OPENCLAW_HOOK_TOKEN"]
---

# Sprout Tool Attempt

Emits `tool:sprout.call_attempted` for every observed tool call. If the tool is
in Sprout's denied built-in set, it emits `tool:sprout.call_denied` and returns
a deny response.

For `web_search`, the hook applies the SPR-OCL-003 web-search query discipline
as an observability and soft-block guard. It blocks obvious secrets, local file
paths, private repo snippets, customer-private material, and unreleased Zeke
strategy content without emitting raw query text.
