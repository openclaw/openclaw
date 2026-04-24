# Channel Plugin Pairing & Allowlist Notes

This directory holds the in-process adapters and registry seams that channel
plugins plug into for pairing, allowlisting, and inbound/outbound routing.
The shell at [pairing.ts](pairing.ts) looks small (~64 LOC) but it is the
single dispatch point where a non-paired sender crosses into the paired
space — treat it as a control-plane boundary, not plumbing.

## Pairing state lives elsewhere

`pairing.ts` in this directory is the registry-aware adapter shim. The
durable pairing state — pending requests, approved codes, single-use
enforcement, TTL pruning — lives in `src/pairing/pairing-store.ts`
(~680 LOC) and its on-disk JSON files under `resolvePairingPaths(...)`.
When you read this file, read those together; every guarantee promised
here relies on the store preserving it.

## Invariants that must hold

### Pairing codes are single-use

When a pairing request is approved, the entry is removed from the store
**atomically inside the same `withFileLock`**. Concretely:
`src/pairing/pairing-store.ts:668-672` does `pruned.splice(idx, 1)` + a
write-back inside the file lock, so two approvers racing on the same code
will serialize on the lock and the second caller will see an empty match.

Do not introduce any path that reads the code, acts on it, then writes
the removal separately. Read-use-write without the surrounding lock
re-opens a replay window.

### Approve → allowlist update → credential write must be one transaction

The happy path for channel pairing ends with:

1. `approveChannelPairingRequest` removes the pending entry (inside
   `withFileLock`).
2. `addChannelAllowFromStoreEntry` appends the approved sender to the
   channel's allow-from list (inside its own lock over the allow-from
   file).
3. The pairing adapter's `notifyApproval` hook runs, which may persist
   channel credentials in the plugin's own `credentials.ts`.

The store currently guarantees step 1 atomically, and 2 atomically, but
**not 1+2+3 as a single unit**. If the gateway crashes between 2 and 3,
you end up with an allowed sender that has no credentials — which
manifests as a bot that accepts messages but cannot act. Don't assume
the transitive atomicity; if you add a new post-approval side effect,
make it idempotent and retry-safe, or guard the earlier steps from
commit on failure.

### Shared-auth and device-token have different per-RPC guarantees

This asymmetry is subtle and load-bearing:

- **Shared-auth clients** (`usesSharedGatewayAuth: true`) are re-checked
  on every RPC against `sharedGatewaySessionGeneration` at
  `src/gateway/server/ws-connection/message-handler.ts` in the per-request
  dispatch block. A token rotation forces the next RPC from any stale
  client to close with `4001 gateway auth changed`.
- **Device-token clients are not re-checked per RPC on `main`.** A
  `device.token.rotate` / `.revoke` schedules the socket close via
  `queueMicrotask`, so RPCs already pipelined in the WS buffer can land
  with the old token before the disconnect takes effect. The PR
  `fix/gateway-device-token-rpc-revalidation` proposes closing this race
  with a synchronous `invalidated` flag on `GatewayWsClient` set before
  `respond()` and checked at the top of the per-RPC dispatch — but until
  that PR lands, **treat `device.token.rotate` / `.revoke` as
  best-effort rather than race-safe**, and be careful about adding
  operations whose correctness depends on the rotate response arriving
  before any further RPC is processed.

If you add a new auth method in this zone, decide explicitly which of
these two per-RPC check shapes it follows and document it. Don't leave
the third case "I didn't think about it" — that is exactly how the
device-token race exists in the first place.

## What must never happen

- A pairing code served twice (across different approvers, or the same
  approver retrying after a partial write).
- A paired device present in the store with no entry in the channel's
  `allowFrom` list, or vice versa. If the two stores disagree, a
  previously-paired sender may silently get rejected or a revoked sender
  may silently get accepted.
- A `device.token.rotate` / `.revoke` completing (from the admin's
  point of view) while pipelined RPCs on the rotated client can still
  authenticate with the old token. Whichever mechanism closes this race
  (the in-flight `invalidated` flag proposal, or something equivalent),
  the invariant is that the old-token authority ends **before** the
  response flush, not after — a microtask-scheduled disconnect alone is
  not sufficient.
- A pairing adapter's `notifyApproval` throwing without a downstream
  catch that either (a) rolls the approval back or (b) logs the
  partial-commit loudly. Silent failure here is the pattern that put
  three separate bugs in the repo this week.

## Verification

- If you change pairing-code issuance, claim, or expiry in
  `src/pairing/pairing-store.ts`, re-read this file and update the
  invariants above; documentation drift here is a near-certain path to
  future bugs.
- After any change to `pairing.ts` or `pairing-store.ts`, run the
  pairing-adjacent test lanes: `pnpm test src/pairing` and
  `pnpm test src/gateway/server-methods/devices.test.ts`.
- The `fix(pairing): clear stale requests on device removal (#70239)`
  path is prior art on the "two stores must agree" invariant — check
  it's still in place if you refactor the removal flow.
