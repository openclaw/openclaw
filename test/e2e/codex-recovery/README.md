# Codex recovery fault injection

This opt-in integration fixture runs the real Gateway agent RPC, Codex harness, and an installed native app-server against a local synthetic Responses server (HTTP/SSE and WebSocket). An authenticated WebSocket proxy uses a non-loopback hostname mapped to loopback inside the child process, exercising remote transport selection. It requires Node 24 and prepared repository dependencies; it uses isolated HOME/config/state and no real credentials. The default local mode is not evidence of production networking, Linux, or Slack delivery.

Run from the repository root with a new, disposable output directory and an explicitly selected native binary:

```sh
OPENCLAW_CODEX_RECOVERY_BINARY=/absolute/path/to/codex \
  node --import ./scripts/tsx.mjs test/e2e/codex-recovery/repro.mjs \
  /absolute/path/to/new-output gateway-remote-active-lost-result-effect
```

`OPENCLAW_CODEX_RECOVERY_MODEL` optionally selects an installed catalog model (default `gpt-5.4`); model responses are entirely synthetic. No model API is contacted.

Scenarios:

- `gateway-remote-sibling-drift`: overload with changing persona text while a sibling stays active.
- `gateway-remote-active`: drop a tool request before delivery.
- `gateway-remote-active-lost-result-effect`: execute a file append, then drop its successful result.
- `gateway-remote-joint-drift-sibling-effect`: overload, prompt drift, then lose a completed tool result while a sibling runs.
- `gateway-remote-joint-model-fallback-drift-sibling-effect`: keep the primary model overloaded so a different model must recover, then exercise the same disconnect and side-effect checks.
- `gateway-remote-auth-fallback`: all three models fail without authentication; the fixture owner restores a synthetic native credential before the same-session and independent follow-up requests. OpenClaw does not manufacture credentials.
- `gateway-remote-auth-fallback-drift`: additionally change persona text after the failed request to exercise configuration handoff on the next request. The synthetic provider asserts that both follow-up requests receive the changed persona in their latest applicable developer message, preserving older instructions as history.
- `gateway-remote-active-lost-result-effect-gateway-restart`: kill the Gateway after the file append, retaining native and SQLite; require same-thread recovery with the original tool history and one file marker.
- `gateway-remote-active-lost-result-effect-restart`: kill and restart native after the side effect; require bounded failure plus successful new work.
- `gateway-remote-active-lost-result-effect-outage`: reject reconnections until the original request ends; then restore access and require new work.

Every repaired scenario asserts subsequent requests in both the same and an independent conversation complete. Effect scenarios assert the file contains exactly one marker. Successful original requests must emit one logical terminal event, with no final error. Restart/outage scenarios expect a terminal original failure, not speculative task replay. The pre-fix active/result-loss baseline can be checked with `--expect-broken`: original failure, blocked same-conversation follow-up, and a successful independent request.

The fixture records the source commit and working-change hash, native version, wire events, agent lifecycle events, Gateway results, and side-effect marker in the supplied directory. It rejects source changes during execution and terminates owned processes and releases port claims in `finally`. Retain output only for an active comparison; remove it when that comparison is finished. Heartbeat and Slack notification behavior have separate dispatch tests; the default mode does not send chat messages. A synthetic configuration change demonstrates that recovery boundary, not the cause of a production configuration change.

## Legacy state across an upgrade

Run the Gateway-restart scenario from a prepared baseline source export and set
`OPENCLAW_CODEX_RECOVERY_RESTART_SOURCE` to the candidate repository. After the
baseline Gateway restarts, the fixture requires its same-conversation request to
fail while independent work succeeds. It then starts the candidate Gateway on the
same native process, proxy endpoint, and SQLite state. No legacy receipt is
manufactured. Both source snapshots are checked for changes, and the baseline
results are saved separately. Source exports use `.recovery-source.json` with the
exact `commit` and a `files` array covering the exported source and fixture overlay.

## Optional managed-native and live Slack mode

`OPENCLAW_CODEX_RECOVERY_REMOTE_NATIVE_URL` selects an existing test app-server;
`OPENCLAW_CODEX_RECOVERY_REMOTE_NATIVE_AUTH_ENV` names its already configured
credential environment variable. Existing native processes and credentials are
never restarted or changed. Record its verified version using
`OPENCLAW_CODEX_RECOVERY_NATIVE_VERSION`. With a real upstream model, responses are
not synthetic: inspect actual wire events and model/tool outcomes.

Live Slack additionally requires `OPENCLAW_CODEX_RECOVERY_LIVE_SLACK=1`, the exact
`OPENCLAW_CODEX_RECOVERY_SLACK_CHANNEL` and `OPENCLAW_CODEX_RECOVERY_SLACK_USER`, and
`OPENCLAW_CODEX_RECOVERY_SLACK_BOT_ENV` / `_SLACK_APP_ENV` naming existing credential
environment variables. Use an authorized test app with one socket consumer. The
caller owns temporarily stopping/restoring its original consumer and sends real
messages through Slack; the fixture does not inject Slack events. Keep credentials
out of source, arguments, logs, and exported artifacts.

The fixture writes its loopback control address to `fixture-control.json`.
`GET /__fixture/status` reports injection and effect counts; POST requests to
`/__fixture/offline`, `/__fixture/online`, and `/__fixture/upgrade` control only the
isolated test Gateway connection/source. `POST /__fixture/stop` stops that Gateway.
Live mode checks that the fault ran and the tool effect occurred once, but its
completion explicitly requires external Slack assertions: record actual ingress,
thread delivery, passive silence, direct-request feedback, and later same/other
conversation success. A successful local fixture or connected Slack socket is not
that proof. Preserve task-owned native test thread IDs for cleanup after evidence
is captured; never interrupt unrelated native work.

The `gateway-remote-active-lost-completion-effect-gateway-restart-automatic-startup`
mode lets the original tool result reach native, then drops the completed turn
notification and kills the Gateway. Native has finished but host settlement is
unknown. This must obey the same no-replay rule as an interrupted native turn.

### Automatic startup continuation

In local mode, add `-automatic-startup` to the Gateway restart mode to wait for the real startup
scheduler before issuing either fresh request. The fixture requires an internal
restart continuation in the durable transcript, a terminal recovery outcome, and
cleared recovery ownership. The synthetic provider attempts to repeat the effect
if inference occurs during the startup phase. An acknowledged transition closes that
phase before fresh requests; quoted restart text in later history does not trigger
the adversarial response. The repaired path must end the
uncertain old task without that inference, then complete both fresh requests with
the original history and exactly one effect. This tests a bounded failure of the
old task; it does not label an interrupted task successfully completed.

For an existing remote native, set `OPENCLAW_CODEX_RECOVERY_REMOTE_PROVIDER_MODE=existing-native`
plus the verified `OPENCLAW_CODEX_RECOVERY_MODEL` and native version. It uses that
native's existing authenticated provider; the local synthetic provider configuration
is not installed remotely. Deterministic overload proof is a separate local test.
Remote provider fail/healthy controls are rejected; offline/online controls affect
only the fixture's transport. The proxy rejects shared account/config mutations and
records allowlisted protocol metadata rather than credentials, prompts or tool bodies.
The existing Slack listener must be safely handed off before starting this isolated
listener. A real-provider fixture pass still requires external Slack assertions.

### Live admission and recovery evidence

After real Slack ingress, read its session/run identity from `agent-events.jsonl`.
POST `{"sessionKey":"<observed test-channel session>","probeId":"<unique label>"}`
to `/__fixture/inspect-session`. Require the matching
`live-session-<probeId>.json` receipt; HTTP 202 alone is not proof. The real Gateway
reads its initialized durable store and exports only lifecycle, user-turn transport
correlation and provenance, not conversation text. Capture this receipt before
sending the next request, since later work legitimately changes session state.

For lost-result startup recovery, correlate the original Slack timestamp and run,
a new runtime-stamped automatic lifecycle, its persisted internal-system input
(`main_session_restart_recovery`), terminal outcome and cleared ownership. For a
completed native turn, either that path or a proven delivered-terminal checkpoint
may reconcile the session. The checkpoint path requires `status=done`, cleared
recovery/delivery state, the exact original source turn and the production
checkpoint reconciliation record, plus the actual sole terminal Slack message.
Do not require another continuation when delivery was already durably confirmed.

For passive silence, first obtain a successful direct reply in a human-rooted test
thread. Send an untagged reply there while only the isolated client transport is
offline. Prove admission by matching that Slack timestamp in the persisted user
turn and the corresponding executed lifecycle; a message rejected by mention
gating is not a silence test. Repeat once, require no bot error replies, then check
that a direct request retains bounded feedback. After restoring transport, require
successful real Slack replies in that thread and another thread. Compare actual
bot message timestamps per logical attempt, including a quiet observation window,
rather than deduplicating by error wording. Keep this external Slack evidence with
the source/native identity and exactly-one-effect assertion; fixture exit alone
never constitutes the full live acceptance result.
