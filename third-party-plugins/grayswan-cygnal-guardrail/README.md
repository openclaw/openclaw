# Gray Swan Cygnal Guardrail

Standalone native OpenClaw plugin that evaluates `before_tool_call` against Gray Swan Cygnal `/cygnal/monitor`.

## Why this plugin exists

This plugin is scoped narrowly on purpose:

- it hooks only `before_tool_call`
- it sees the same model-facing context that OpenClaw is about to use for the tool step
- it can run in either `block` or `monitor` mode

That makes it suitable for external guardrail / monitoring deployments without adding any bundled-core plugin code.

## What Cygnal receives

On each `before_tool_call`, the plugin sends Cygnal:

- the current system prompt
- the full conversation history exposed by the hook
- the model tool definitions (`tools`) exposed by the hook
- metadata about the hook, selected model, and current tool call

## Config

```json5
{
  plugins: {
    entries: {
      "grayswan-cygnal-guardrail": {
        enabled: true,
        config: {
          apiKey: "${GRAYSWAN_API_KEY}",
          apiBase: "https://api.grayswan.ai",
          policyId: "policy_example",
          reasoningMode: "hybrid",
          violationThreshold: 0.5,
          timeoutMs: 30000,
          failOpen: true,
          cygnalBypass: false,
          beforeToolCall: {
            enabled: true,
            mode: "block",
            violationThreshold: 0.5,
            blockOnMutation: false,
            blockOnIpi: false,
          },
        },
      },
    },
  },
}
```

## Notes

- `apiKey` falls back to `GRAYSWAN_API_KEY`.
- `apiBase` falls back to `GRAYSWAN_API_BASE` and then `https://api.grayswan.ai`.
- `cygnalBypass: true` sets `metadata.cygnal_bypass=true`.
- `OPENCLAW_GUARDRAIL_DEBUG=1` emits request lifecycle logs with `logger.error(...)`.

## Local development install

This package is intentionally outside bundled `extensions/` so it behaves like a third-party plugin.

```bash
node openclaw.mjs plugins install --link ./third-party-plugins/grayswan-cygnal-guardrail
```

After linking, configure `plugins.entries.grayswan-cygnal-guardrail` and restart the gateway.
