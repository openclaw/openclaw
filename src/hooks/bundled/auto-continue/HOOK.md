---
name: auto-continue
description: "Resume an autonomous run after the stuck-session watchdog hard-aborts it."
metadata:
  {
    "openclaw":
      { "emoji": "♻️", "events": ["session:aborted"], "defaultEnableMode": "explicit-opt-in" },
  }
---

# Auto Continue

When the stuck-session watchdog hard-aborts an embedded run, this hook re-injects
a short continuation instruction and kicks a fresh turn so the agent resumes its
work loop on its own instead of going silent. A loop-guard caps resumes at 3 per
session per 30 minutes so a pathological abort→continue→abort cycle cannot run
away.

**Requires heartbeats.** The continuation is queued as a system event and
delivered by the next heartbeat turn, so the agent needs a heartbeat cadence
(`agents.defaults.heartbeat.every`). With heartbeats disabled the continuation is
queued and never delivered, and the aborted run stays silent.

This is a backstop behind the existing protection that stops _false_ aborts in
the first place (working runs already refresh the watchdog activity timestamp on
every run event). Auto-continue only matters for a genuine hang.

Because resuming a run automatically is an opinionated behavior change, this hook
is **disabled by default** (`defaultEnableMode: explicit-opt-in`). Enable it with:

```bash
openclaw hooks enable auto-continue
```

Disable with:

```bash
openclaw hooks disable auto-continue
```
