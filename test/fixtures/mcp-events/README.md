# MCP Events developer fixture

A dependency-free, **real HTTP MCP 2.0 server** for the webhook profile described
by [OpenAI](https://developers.openai.com/plugins/build/mcp-events) and the
[draft pinned at 6682596](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/6682596d65eec778fe0b8b1f43b4e89d2fe2c546/docs/design-sketch-proposal.md).
This is developer/test tooling, not a production integration or a substitute for
proof through OpenClaw's actual callback ingress and Automation runner.

## Start

Node 22+ is sufficient; no install or new dependencies. Create two distinct
random **synthetic fixture-only** bearer tokens in private files. Never reuse a
Gateway/provider token. Place the explicit state artifact outside OpenClaw's
product stores; for a task-owned run, use a directory such as
`.openclaw/tmp/mcp-events-proof/` in the authorized checkout.

```sh
node scripts/mcp-events-test-server.mjs serve \
  --state .openclaw/tmp/mcp-events-proof/server.json \
  --token-file .openclaw/tmp/mcp-events-proof/mcp-token \
  --control-token-file .openclaw/tmp/mcp-events-proof/control-token
```

The first stdout line is a JSON readiness receipt with `mcpUrl`, `sseUrl` and
`controlUrl`. Wait for that line, not a sleep. Ports default to OS-assigned free
ports; supply `--port` and `--control-port` to preserve addresses across restart.
SIGTERM/SIGINT closes the fixture. Start it again with the same state path and MCP
token to restore subscriptions, signing-key rotation, retained events, access
revocations, and pending deliveries. Use **one process per state artifact**.
The JSON file is an explicit external-tool contract, mode 0600; it contains
fixture signing secrets. Do not commit it or copy real data into it.

The MCP listener defaults to loopback HTTP. For a non-loopback listener, supply
`--host`, `--tls-key`, and `--tls-cert`; TLS is required there. Controls are always
on a separate loopback-only listener and require the separate control token.
No controls are exposed as MCP tools.

### Callback TLS and network safety

Ordinary callback URLs must be HTTPS and resolve only to public addresses. Every
POST (including verification and retries) resolves and pins the validated
address, preserves TLS hostname verification, and refuses redirects. Normal
events are capped at 262,144 bytes. Callback responses are capped at 16 KiB.

For **isolated local proof only**, create a local CA and a server certificate
whose SAN covers the exact callback host. Trust the CA in the isolated receiver
and client setup, and give this fixture both:

```text
--loopback-callback-origin https://localhost:CALLBACK_PORT
--callback-ca PATH_TO_CA_CERTIFICATE
```

Only that exact origin may resolve to 127.0.0.1 or ::1; TLS/hostname checks remain
on. This exception is fixture-owned, not a production OpenClaw flag. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`. For a Gateway served over loopback HTTP, use an
isolated HTTPS reverse proxy with the test certificate, not a plaintext callback.
The product's outbound MCP policy is still independently enforced; use its
supported configured fixture policy or a public HTTPS MCP endpoint.

## Protocol

`/mcp` returns JSON. `/mcp-sse` returns exactly one JSON-RPC result in a
request-scoped SSE response and closes it. Both require bearer authentication,
`MCP-Protocol-Version: 2026-07-28`, `MCP-Method` matching the body method, and
`params._meta` with matching `io.modelcontextprotocol/protocolVersion` and object
`io.modelcontextprotocol/clientCapabilities`. There is no initialize handshake.
The read-only `status` control records bounded method/transport receipts, never
bearer or callback secrets.

- `server/discover` advertises events.
- `events/list` returns `comment.created` then `comment.updated` on a second page.
- Each event filters by required `document_id` and optional `text_contains`.
- Payload fields are `document_id`, `comment_id`, `text`, `url` (strings).
- `events/subscribe` validates inputs and the signing secret, sends a signed
  random challenge, waits for a constant-time 2xx echo, persists, then replies.
  IDs hash principal + URL + name + canonical flat arguments. A single fixture
  token maps to the stable principal `fixture-account`.
- `ttlMs` defaults to an hour; finite requests grant 100 ms–24 hours.
  For bounded live renewal proof, `serve --max-ttl-ms 15000` caps the
  **server-granted** finite lease at 15 seconds; the programmatic equivalent is
  `maxTtlMs: 15000`. The cap must be an integer from 100 to 86,400,000 ms.
  This changes only the fixture server lease, not the product clock or scheduler.
  `ttlMs: null` still grants durable no-expiry subscriptions. Expired/revoked
  subscriptions stop sending. Refresh may rotate the key; both keys sign for
  60 seconds. Successful verification is cached per principal/URL for 60 seconds.
- Retained history is bounded to the last 1,000 events. Cursors are opaque to the
  client. Refresh/replay resumes after a supplied cursor; discarded history
  sets `truncated: true`. Delivery is serial per subscription,
  so payload cursors never skip an earlier pending event. Subscription responses
  return the last settled position, not the head while events await delivery.
- Retries preserve event ID, occurrence time, and serialized body. Every attempt
  recomputes the signing time and HMAC. At most three attempts; backoff is 250/500
  ms, with Retry-After honored (a delay over 30 seconds ends this bounded run).
  410/413 and permanent 4xx are not retried. A bounded run may abandon delivery;
  retained source history remains available through explicit cursor replay.
- `events/unsubscribe` is identity-based and idempotent.
- Tools, poll, push, gap, terminated, and OAuth are intentionally not implemented.

## CLI and live driver controls

```sh
node scripts/mcp-events-test-server.mjs control \
  --url http://127.0.0.1:CONTROL_PORT/control \
  --token-file PATH_TO_CONTROL_TOKEN --json '{"action":"status"}'
```

For TLS CLI calls, use `NODE_EXTRA_CA_CERTS=PATH_TO_CA`. HTTP errors
are observable in the JSON output; control calls report per-attempt statuses.

Send these JSON control bodies to `controlUrl` using bearer auth. All data must
be synthetic. Unless stated otherwise, `emit`/`burst` wait for attempted delivery.

| Scenario       | Control body / MCP request                                                                                                                                                     | Evidence to check in the real receiver                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Normal/filter  | `{"action":"emit","eventId":"evt_live_1","data":{"document_id":"doc_fixture","comment_id":"comment_1","text":"Synthetic review comment","url":"https://example.com/fixture"}}` | Matching Automation run contains the payload; nonmatching subscription receives nothing |
| Duplicate      | `{"action":"retry","subscriptionId":"sub_...","eventId":"evt_live_1"}`                                                                                                         | Stable event ID, no second Automation effect                                            |
| Bad HMAC       | `{"action":"invalid-signature","subscriptionId":"sub_...","eventId":"evt_live_1"}`                                                                                             | Authentication rejection, no new stored ingress/effect                                  |
| Oversize       | `{"action":"oversize","subscriptionId":"sub_...","eventId":"evt_live_1"}`                                                                                                      | Signed body over 256 KiB rejected, no effect; one explicit probe only                   |
| Burst          | `{"action":"burst","count":10,"data":{...same fields...}}`                                                                                                                     | Distinct IDs; assert enabled/disabled batching using actual Automation receipts         |
| Expire         | `{"action":"expire","subscriptionId":"sub_..."}`, then emit                                                                                                                    | No delivery until a real `events/subscribe` refresh                                     |
| Rotate         | Real `events/subscribe` with same identity/new secret                                                                                                                          | Same ID; during grace receiver accepts one of two Standard Webhooks signatures          |
| Restart        | SIGTERM; restart same state/ports                                                                                                                                              | Durable subscription works without recreation; pending delivery resumes                 |
| Replay         | Expire, emit, real subscribe with previously saved cursor                                                                                                                      | Missed event reaches ingress, cursor does not skip pending work                         |
| Truncate       | `{"action":"truncate","throughCursor":"fixture:N"}`, expire and resubscribe from older cursor                                                                                  | `truncated:true` and recoverable retained history                                       |
| Revoke         | `{"action":"revoke","documentId":"doc_fixture"}`                                                                                                                               | No subsequent delivery; new subscribe is forbidden; `grant` reverses fixture access     |
| Unsubscribe    | Real `events/unsubscribe` with original name/arguments/URL                                                                                                                     | Empty result twice; later emit has no matching delivery                                 |
| Settled replay | `{"action":"drain"}`                                                                                                                                                           | Waits on replay delivery promises; no arbitrary sleep needed                            |

For programmatic orchestration, import `startMcpEventsTestServer` from
`server.mjs`; options mirror CLI names in camelCase (`stateFile`, `token`,
`controlToken`, `loopbackOrigin`, `ca`, optional `maxTtlMs`, `tls:{key,cert}`). Await
`close()` before restarting. The actual plugin ingress/Automation driver owns
subscription creation, Gateway isolation, durable receipt assertions, and cleanup.
Do not claim end-to-end proof from a fixture 2xx alone.

## Isolated real-provider acceptance

After source freeze and a successful build, provision a proxy-reachable HTTPS
origin forwarding **only** `/plugins/mcp-events/callback/*` to a chosen loopback
Gateway port. All other paths must return 404. The runner does not provision
public listeners, change TLS trust or proxy policy, or expose Gateway administration.

```sh
OPENCLAW_MCP_EVENTS_LIVE=1 node scripts/e2e/mcp-events-live.mjs --run \
  --source-head "$(git rev-parse HEAD)" \
  --callback-origin https://CALLBACK_HOST --gateway-port 18871
```

The Linux runner requires an inherited `OPENAI_API_KEY`, uses a disposable profile
and real `openai/gpt-4.1-mini` calls (override with `--model`), and records source,
process, Automation receipt, effect, and cleanup evidence in a fresh directory
under `.openclaw/tmp/mcp-events-proof/`. Optional `--root` must name a fresh direct
child of that directory. Do not commit its private tokens or runtime artifacts.
It tests JSON/SSE, pagination, signed verification, filtering, dedupe, invalid
signatures, body limits, busy bursts, renewals, rotation, replay/truncation, cold
restarts, interrupted activation, and disable/delete cleanup. A callback ACK
alone is not proof of Automation execution.
