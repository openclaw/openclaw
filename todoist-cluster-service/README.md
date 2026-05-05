# Todoist Cluster Service for Stitch

Builds a read-only virtual cluster overlay on top of Stitch's Todoist cache.

It watches `~/.openclaw/workspace/todoist/tasks.json` and writes lean overlay files to:

`~/.openclaw/workspace/todoist/clusters/`

The service never mutates Todoist. It only reads the task cache and writes overlay/index files.

## Start

```bash
cd ~/openclaw/todoist-cluster-service
node index.js
```

## Docker

The service is included in `docker-compose.yml` as `stitch-todoist-clusters`.
It mounts only the Todoist cache and taskbot state directories, then exposes
health locally on `127.0.0.1:3009`.

```bash
docker compose up -d --build stitch-todoist-clusters
curl http://localhost:3009/health
```

## One-shot rebuild

```bash
cd ~/openclaw/todoist-cluster-service
node index.js --once
```

## Verify

```bash
cd ~/openclaw/todoist-cluster-service
node verify-overlay.js
```

## Health

```bash
curl http://localhost:3009/health
```

Health returns HTTP 200 only when the overlay is fresh for the current
`tasks.json`. It returns HTTP 503 when the build failed, has not completed, or
the source task cache is newer than the cluster overlay.

## Work resolver

The service also exposes read-only task execution resolver endpoints for Stitch.
These endpoints do not mutate Todoist or email; they only return the canonical
Next Actions packet Stitch should use before fetching mail.

Stitch should prefer the local snapshot files for normal task briefings because
OpenClaw may block private/internal HTTP fetches from agent tools:

- `~/.openclaw/workspace/taskbot/work-next.json`
- `~/.openclaw/workspace/taskbot/work-next-brief.md`
- `~/.openclaw/workspace/taskbot/work-clusters.json`

The snapshots are rewritten after each successful overlay build and contain the
same deterministic packet/menu data as the HTTP resolver.
`work-next-brief.md` is a compact ready-to-send card for the fastest normal
"what's my next task?" path.

Basic next-task briefings should consume `work-next-brief.md` first, then fall
back to `work-next.json` and render that packet. They should not read
`todoist/tasks.json` unless the lean packet is stale or missing after a refresh
retry.

From the host:

```bash
curl http://localhost:3009/work/next
curl http://localhost:3009/work/clusters
curl 'http://localhost:3009/work/task?id=TASK_ID'
curl 'http://localhost:3009/work/cluster?id=CLUSTER_ID'
```

From inside the OpenClaw Docker network, use:

```bash
curl http://stitch-todoist-clusters:3009/work/next
```

`/work/next` returns one deterministic packet with the selected cluster, task
position, canonical subject line, starting mailbox, safe mail-helper request,
and presentation hints. If the overlay is stale, it fails closed with HTTP 503
instead of returning stale task routing data.

## Output files

- `~/.openclaw/workspace/todoist/clusters/summary.json`
- `~/.openclaw/workspace/todoist/clusters/task-index.json`
- `~/.openclaw/workspace/todoist/clusters/by-id/*.json`
- `~/.openclaw/workspace/todoist/clusters/overrides.json`
- `~/.openclaw/workspace/todoist/clusters/build-status.json`

## Overrides

Edit `~/.openclaw/workspace/todoist/clusters/overrides.json` to force a task into a cluster, split a task out, merge clusters, or rename cluster metadata.

The watcher rebuilds automatically when `tasks.json` or `overrides.json` changes.
