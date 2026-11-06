# Update acknowledgement: joined module proof

**syntheticGatewayDiscord / not live.** No Discord API acceptance, live receipt,
actual client rendering, real slash-command ingress authorization, complete
`update.run` execution, software update, or service restart is claimed.

## Production chain

The shipped Discord native reply adapter calls the public SDK channel turn, real
core dispatcher/finalizer, and the real `/update` producer through an injected
reply resolver. The producer receives the same operation-owned reply options as
the finalizer. The synthetic Gateway calls the real lifecycle notice queue owner,
with real current SQLite preparation/admission/storage/committed custody. The
producer's actual completion reaches the finalizer and returns through the real
SDK/channel lifecycle to the shipped Discord adapter and settlement helper.

Only external Gateway/Discord I/O and existing shared session/model/ACP/hook/TTS
surroundings are synthetic. No completion or finalizer result is supplied by a
mock. The server's `update.run` method and notifier are not executed: the Gateway
fixture maps actual lifecycle owner facts into their response contract. Delivered
transport acceptance uses a clearly synthetic receipt, not a Discord receipt.
Pending is a real durable enqueue followed by sending the same owned intent; it
proves custody, not subsequent retry or eventual delivery. Noack is a controlled
Gateway transport rejection, not an executed server-side no-custody branch.

## Behavioral evidence

Production source snapshot: `d533d14ece9e7eb5a4275cb73dd4a9a5e42c1e2e`.
The fixture was independently reviewed and all three source snapshots replayed
before relocation into the native cross-plugin integration lane. Historical red
runs overlay every changed production module on current shared test scaffolding;
they are not full historical checkouts. No older consumer implementation is copied.

| Production source                          | Delivered / pending                                                                    | Noack control |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------- |
| `06acff14158252c6f2b4784513bcd9d781e6b9f9` | Both fail: core sends “No answer was returned. Ask again if you still need one.”       | Pass          |
| `1fb2a0965f15089ced430f06f6f01e3a01e9212d` | Both fail: core has zero counts, Discord sends “⚠️ Command produced no visible reply.” | Pass          |
| `d533d14ece9e7eb5a4275cb73dd4a9a5e42c1e2e` | Both pass: no core/channel warning; deferred response deleted once                     | Pass          |

- Delivered: queue **completed**, synthetic acceptance, producer/finalizer
  **delivered**, dispatch counts all zero, no observed-reply-delivery claim.
- Queued: queue **pending**, `ackDelivered:false`, producer/finalizer **pending**,
  counts all zero, no accepted transport or fabricated receipt.
- Noack: producer completion remains **missing**; the real recovery warning
  “⚠️ Couldn't confirm the update…” reaches synthetic Discord followUp once,
  final count one, no deferred-response deletion. A delivered recovery warning
  does not mean an update acknowledgement was delivered.

For delivered and pending the real adapter calls deleteReply once and never
followUp/editReply; the synthetic interaction settles to replied. These are
adapter calls/state, not a Discord service or human observation.

## Ownership boundary

The host owns this joined core/lifecycle composition and its private core fixtures.
It enters the shipped Discord adapter only through the plugin-owned lazy
`loadDiscordNativeAgentReply` seam in `extensions/discord/test-api.ts`. The plugin
retains its implementation; no private core helpers become Plugin SDK exports,
and extension tests do not import core internals. Both ownership guards apply.

## Native reproduction

```sh
pnpm test test/plugins/discord-update-acknowledgement.integration.test.ts --maxWorkers=1
```

Original joined-fixture native run: **3/3 passed**, 56.515 s wall (including SQLite worker
lifecycle/cleanup and compilation). The real joined custody-to-adapter contract
requires this heavier integration; isolated helper fixtures cannot prove it.
Owning root integration types and scoped type-aware lint pass; the staged native
LF guard passes. No full product build or live proof is claimed.

The native database-worker inventory selects the infra fork pool, which owns the
host SQLite broker. Do not run this SQLite composition in a thread pool.
The added LF allocation protects this joined lifecycle/consumer risk missed by
separate boundary fixtures; it does not change the shared scalar or guard rules.

To reproduce either historical red result, use a disposable checkout with the
current test, native routing and matching frozen dependencies. Restore these six
production paths from the selected historical SHA, run the same command (expect
exactly delivered/pending failures and a passing noack control), then restore the
production paths from HEAD. Never do an overlay in a shared or dirty checkout:

- `extensions/discord/src/monitor/native-command-agent-reply.ts`
- `src/auto-reply/reply/commands-update.ts`
- `src/auto-reply/reply/dispatch-from-config.finalize.ts`
- `src/auto-reply/reply/dispatch-from-config.types.ts`
- `src/channels/turn/dispatch-result.ts`
- `src/channels/turn/execution.ts`

No live Discord actions or credentials are required for this test. Live-only
acceptance/UI evidence remains outside its scope.
