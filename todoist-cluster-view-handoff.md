# Todoist Cluster View Handoff

## Chosen architecture

Phase 1 ships as a new native read-only companion service:

- Repo code: `/Users/chrisreyes/openclaw/todoist-cluster-service/`
- Live overlay output: `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/`
- LaunchAgent: `/Users/chrisreyes/openclaw/launchd/com.openclaw.todoist-cluster-service.plist`

I chose this over modifying `todoist-service` because it is the safest fit for Chris's existing OpenClaw setup:

- it keeps the critical Todoist writer untouched
- it reads the exact local cache Stitch already trusts: `~/.openclaw/workspace/todoist/tasks.json`
- it introduces no new credentials
- it never writes back to Todoist
- it fits the same file-based / native-service pattern already used by the local calendar service

## What it does

The service watches:

- `~/.openclaw/workspace/todoist/tasks.json`
- `~/.openclaw/workspace/todoist/clusters/overrides.json`

On startup and on file change, it rebuilds a virtual overlay with:

- `summary.json` for low-token top-level cluster listing
- `task-index.json` for task_id -> cluster resolution
- one detail file per cluster under `by-id/`
- `build-status.json` for freshness / health
- `debug-summary.md` for quick human inspection

No real Todoist tasks are merged, edited, completed, moved, reordered, or deleted.

## Data contract

Top-level files:

- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/summary.json`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/task-index.json`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/build-status.json`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/overrides.json`

Per-cluster files:

- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/by-id/*.json`

Per task, the overlay preserves:

- original Todoist fields
- cluster membership
- why the task is in the cluster
- mailbox
- subject hint
- normalized subject lookup key
- msgId as a secondary hint only
- thread lookup method
- traceability confidence

Microsoft tasks are wired for canonical subject-based retrieval.
Gmail is explicitly marked as best-effort subject search/detail because the current Gmail reader has no full thread fetch action.

## Stitch wiring

New skill:

- `/Users/chrisreyes/.openclaw/workspace/skills/todoist-clusters/SKILL.md`

Small routing pointers were added to:

- `/Users/chrisreyes/.openclaw/workspace/AGENTS.md`
- `/Users/chrisreyes/.openclaw/workspace/skills/todoist/SKILL.md`

The new skill teaches Stitch how to:

- show my clusters
- show waiting clusters
- open cluster <name>
- explain why tasks were grouped
- answer what thread is behind this task
- list source traces in a cluster
- stay conversationally scoped inside one cluster without writing any new state

## Files created / changed

Created in repo:

- `/Users/chrisreyes/openclaw/todoist-cluster-service/clusterer.js`
- `/Users/chrisreyes/openclaw/todoist-cluster-service/index.js`
- `/Users/chrisreyes/openclaw/todoist-cluster-service/package.json`
- `/Users/chrisreyes/openclaw/todoist-cluster-service/verify-overlay.js`
- `/Users/chrisreyes/openclaw/todoist-cluster-service/README.md`
- `/Users/chrisreyes/openclaw/launchd/com.openclaw.todoist-cluster-service.plist`
- `/Users/chrisreyes/openclaw/todoist-cluster-view-handoff.md`

Created / changed in workspace:

- `/Users/chrisreyes/.openclaw/workspace/skills/todoist-clusters/SKILL.md`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/overrides.json`
- `/Users/chrisreyes/.openclaw/workspace/AGENTS.md`
- `/Users/chrisreyes/.openclaw/workspace/skills/todoist/SKILL.md`

Generated overlay files:

- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/summary.json`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/task-index.json`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/build-status.json`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/debug-summary.md`
- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/by-id/*.json`

## Live verification that was run

Architecture verified locally before coding:

- `~/.openclaw/workspace/todoist/tasks.json`
- `~/.openclaw/workspace/skills/todoist/SKILL.md`
- `~/.openclaw/workspace/skills/email/SKILL.md`
- `~/.openclaw/workspace/AGENTS.md`
- `~/openclaw/todoist-service/index.js`
- `~/openclaw/mail-reader/index.js`
- `~/openclaw/docker-compose.yml`
- `~/openclaw/readiness-shadow.cjs`
- `~/.openclaw/workspace/readiness-email-export/threads.jsonl`

Code verification:

- `node --check /Users/chrisreyes/openclaw/todoist-cluster-service/clusterer.js`
- `node --check /Users/chrisreyes/openclaw/todoist-cluster-service/index.js`
- `node --check /Users/chrisreyes/openclaw/todoist-cluster-service/verify-overlay.js`

Overlay build verification:

- `cd /Users/chrisreyes/openclaw/todoist-cluster-service && node index.js --once`
- Result: `generated 26 clusters from 32 tasks`

Acceptance verification:

- `cd /Users/chrisreyes/openclaw/todoist-cluster-service && node verify-overlay.js`
- Result:
  - `verify: ok`
  - `tasks: 32`
  - `clusters: 26`
  - `multi_task_cluster: client-jennifer-miller-studio-quotes Jennifer Miller Studio — Quotes 3`
  - `singletons: 21`

Watcher verification:

- LaunchAgent bootstrapped successfully
- `curl http://localhost:3009/health` returned healthy status
- touching `overrides.json` triggered a rebuild and advanced `last_build_finished_at`

Read-only proof:

- `tasks.json` SHA-256 before overlay work:
  - `faae38acb6dadc72a751fda276d9ac0d24e200f76cc01af366eacf64e4361fe9`
- `tasks.json` SHA-256 after build + watcher verification:
  - `faae38acb6dadc72a751fda276d9ac0d24e200f76cc01af366eacf64e4361fe9`

## Real packets confirmed on the current live pile

Confirmed multi-task packets:

- `Jennifer Miller Studio — Quotes` with 3 preserved underlying tasks
- `Assembly Studio — Quotes` with 2 preserved underlying tasks
- `Anne's 3 pillows — Quote Thread` with 2 preserved underlying tasks

Example packet detail:

- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/by-id/client-assembly-studio-quotes.json`

This cluster preserves both underlying Assembly Studio quote tasks separately, with separate source traces, while exposing one virtual packet above them.

## Restart / reload

Health:

```bash
curl http://localhost:3009/health
```

One-shot rebuild:

```bash
cd /Users/chrisreyes/openclaw/todoist-cluster-service
node index.js --once
```

Run verification:

```bash
cd /Users/chrisreyes/openclaw/todoist-cluster-service
node verify-overlay.js
```

Restart launchd service:

```bash
launchctl bootout gui/$(id -u)/com.openclaw.todoist-cluster-service || true
launchctl bootstrap gui/$(id -u) /Users/chrisreyes/openclaw/launchd/com.openclaw.todoist-cluster-service.plist
curl http://localhost:3009/health
```

## How Chris / Stitch should use it

Top level:

- read `summary.json`
- keep the response tight
- only drill into one cluster when Chris asks

Drill-down:

- resolve alias / display name from `summary.json`
- open only that cluster detail file
- preserve every original task and every original source trace

Thread lookup:

- use `task-index.json` to find the cluster and per-task trace fields
- for Microsoft, use the preserved subject hint with `fetch-thread-by-subject`
- treat `msg_id` as secondary only

## Known limitations

- This is Phase 1 only: no task mutation, no drafting, no automation, no auto-clear behavior
- The overlay is intentionally conservative; uncertain cases stay singleton
- The service only uses the local Todoist cache, so `created_at` / `updated_at` remain null when the cache does not include them
- Gmail traces are explicitly best-effort because the Gmail reader does not expose a full thread fetch action
- "keep me inside this cluster" is conversational scope in Stitch, not persisted machine state

## Manual overrides

Edit:

- `/Users/chrisreyes/.openclaw/workspace/todoist/clusters/overrides.json`

Supported override patterns:

- split a task out into its own singleton
- force a task into a named cluster
- merge two generated clusters
- rename / retitle a cluster
- add aliases
- change summary, kind, blocking party, or pinned order

The watcher rebuilds automatically after edits.

## Phase 2 ideas (not shipped here)

- add a compact "current cluster" state file if conversational scoping needs persistence across sessions
- add trace enrichment from readiness export / mailbox history when it improves confidence without bloating tokens
- add manual cluster notes / packet notes per cluster
- add lightweight stale-cluster detection and follow-up suggestions
- add opt-in packet actions after Chris explicitly approves them
