# evening report - 2026-04-24

generated: IST evening / EU EOD / US mid-morning

---

## commit count (upstream main, top-30 tracker)

| stat | value |
|------|-------|
| merged PRs (lifetime) | 5 |
| gap to 46 | **41** |
| last merge | #70413 - fix(agents): route /btw (2026-04-23) |

---

## open PR state

### fork PRs (suboss87/openclaw) - live data

| # | title | CI | review | age |
|---|-------|----|--------|-----|
| #3 | fix(configure): preserve custom primary model | checks queued | none | <1d |
| #2 | fix(discord): handle partial GuildThreadChannel | all skipped/cancelled | devin bot only | ~1d |
| #1 | fix(gateway): clean up MCP child processes | **security-fast FAIL** | none | ~1.5d |

### upstream PRs (openclaw/openclaw) - from midday snapshot

| # | title | area | age | status |
|---|-------|------|-----|--------|
| #70413 | fix(agents): route /btw through provider stream fn | agents | <1d | awaiting review |
| #69685 | fix(agents): strip final tags from persisted message | agents | ~2d | awaiting review |
| #68446 | fix(whatsapp): stop DM allowFrom sender bypass | whatsapp | ~5d | awaiting review |
| #66544 | fix(gateway): exclude heartbeat sender from display | gateway | ~9d | awaiting review |
| #66225 | fix(agents): align final tag regexes for self-close | agents | ~9d | awaiting review |

note: upstream MCP access is restricted to fork only; upstream CI/review state comes from midday-check.md

---

## CI findings

**PR #1 security-fast FAILURE** - likely a false positive. The branch
`fix/mcp-nested-run-cleanup` was cut from base `2e8a0b29` (old fork main). Since then,
100+ commits landed on main, making the PR diff 300+ files wide. The security scanner is
scanning upstream drift, not the actual 12-line fix in
`src/gateway/server-methods/agent.ts`. The fix itself touches no credentials, env vars, or
secrets. Needs a rebase before the upstream PR is opened or CI will stay noisy.

**PR #2 cancelled checks** - initial workflow run was cancelled when a new push refreshed
the PR head. Latest run shows all jobs as `skipped` - fork may lack secrets/env for the
full check suite. Not caused by our changes.

**PR #3 queued** - PR opened just before this run. Checks still in queue, expect results
overnight.

---

## maintainer pings sent this run

none - all fork PRs are under the 3-day threshold. upstream PR list includes #66544 and
#66225 at ~9 days old, but upstream is not reachable this run to check ping history.
tomorrow morning should ping for those two if still unreviewed.

---

## rebases needed tomorrow (morning run)

- **fork PR #1** - must rebase `fix/mcp-nested-run-cleanup` onto current fork main to
  collapse the 300-file drift before opening upstream PR or the upstream CI will see the
  same false positives.
- **fork PR #2** - check if `fix/discord-thread-slash-command-partial-channel` also has
  base drift; re-run checks after potential rebase.

---

## top priority for tomorrow morning autopilot

investigate whether upstream PRs #66544 and #66225 (~9 days, no review) need a ping to
@steipete/@jacobtomlinson (gateway and agents area). if upstream is reachable, check
comment history first to avoid double-ping. also confirm #70413 is not yet merged before
sending any follow-up there.

---

## tooling note

upstream openclaw/openclaw not reachable this run via git proxy (HTTP 502) or MCP (session
restricted to suboss87/openclaw). all upstream data is from midday snapshot. fix proxy or
update MCP session scope to unblock full hygiene runs.
