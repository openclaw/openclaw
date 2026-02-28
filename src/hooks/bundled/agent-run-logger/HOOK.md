---
name: agent-run-logger
description: Logs agent run start and end times to a local file for auditing and debugging.
events:
  - agent:beforeRun
  - agent:afterRun
---

# Agent Run Logger

Appends a line to `~/.openclaw/logs/agent-runs.log` for every agent run.

**Before run:**

```
2026-02-26T21:00:00.000Z START sessionKey=agent:main:main
```

**After run:**

```
2026-02-26T21:00:05.123Z END   sessionKey=agent:main:main duration=5123ms length=420
```

Useful for auditing activity, spotting stuck runs, and measuring response times.

## What you can build with `agent:beforeRun` and `agent:afterRun`

These hook events fire around every agent run — before the model is called and after it replies. Some ideas:

- **Status indicator** — write a file when a run starts, delete it when it ends. Any process watching the filesystem can use this to show a "thinking" banner in a local dashboard or sidebar.
- **Performance monitoring** — log `durationMs` over time to spot slow runs or regressions after model/config changes.
- **External notifications** — POST to a webhook when a run completes, so another service knows the agent just responded.
- **Run auditing** — keep a structured log of every run with sessionKey, duration, and response length for compliance or debugging.
- **Idle detection** — if `afterRun` hasn't fired in N minutes after `beforeRun`, something is stuck. Trigger an alert.
