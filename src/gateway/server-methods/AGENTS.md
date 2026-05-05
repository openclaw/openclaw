# Gateway Server Methods Notes

- Pi session transcripts are a `parentId` chain/DAG; never append Pi `type: "message"` entries via raw JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages via `SessionManager.appendMessage(...)` (or a wrapper that uses it).

## Secrets surface (`secrets.ts`)

`secrets.reload` and `secrets.resolve` are the gateway's only RPC entry points into
`src/secrets/`. The file is short (~100 LOC) but sits between a `operator.admin`
scope gate and a ~111-file module that touches every provider, plugin, and
credential persistence path in the repo. Treat it as a thin boundary, not a
place to add logic.

### Threat model

- Both methods are `operator.admin`-scoped per `src/gateway/method-scopes.ts`;
  non-admin clients never reach these handlers.
- The HTTP (OpenAI-compatible / `/tools/invoke`) bearer-token path maps to
  `senderIsOwner: true` at `src/gateway/http-utils.ts:255`
  (`resolveOpenAiCompatibleHttpSenderIsOwner`); the WS shared-secret surface
  carries the same semantics via a parallel path (documented as intentional in
  SECURITY.md). Device-token auth does _not_ get owner by default — this
  asymmetry is load-bearing and must be preserved.
- `secrets.resolve` validates target ids against
  `src/secrets/target-registry.ts` via `isKnownSecretTargetId` before any
  lookup. An unknown target id is a 400, not a 500. Don't swap this for a
  loose `Set.has` that could accept coerced values.

### Invariants that must hold

- **Every error path goes through `errorShape(ErrorCodes.*, ...)`.** No
  `throw` that escapes the handler, no silent `respond(true, ...)` in a
  catch. If `reloadSecrets()` throws, the client must see
  `ErrorCodes.UNAVAILABLE`, not a generic success.
- **`validateSecretsResolveResult` gates the response.** If the resolver
  returns a payload that fails schema, the handler throws and becomes
  `UNAVAILABLE`. Do not relax the post-validation to "log and continue" —
  the gateway is the last line before a plugin sees the assignment.
- **`commandName.trim()` happens after schema validation, not instead of
  it.** Trimming zero-width content is a convenience, not a security check.
- **`targetIds` is filtered for empty strings before lookup.** An empty
  string must never reach the registry.

### What must never regress silently

- No bare `catch {}` or `catch { /* ignore */ }` in this file. If an error
  is swallowed, the caller believes the secret was reloaded/resolved when
  it wasn't. Same class of bug as the three we fixed this week (see
  "Related incidents" below).
- No `respond(true, ...)` in an error path. `valid: true` on a failed
  operation is the shape we're specifically trying to keep out of the
  codebase.
- No logging of raw secret values, ever. `String(err)` on a resolver error
  is fine only because the resolver itself does not embed secret content
  in its error messages — if that ever changes, this logging pattern must
  be revisited (redact-then-log).
- Never accept an `operator.admin` scope from an unauthenticated connect;
  the scope must come from an already-validated device pairing record or
  shared-secret auth path. `client.connect.scopes` is not self-attested.

### Related incidents (silent-failure shape)

Three in-flight PRs target this same class of bug in adjacent files. At
time of writing some may still be open against `main`; treat the shape
description as the invariant, not the merge status:

- `fix/config-restore-false-success` — bare catch on `copyFile` during a
  suspicious-read recovery caused the audit log to report `valid: true`
  after a disk error. Nobody saw the restore had failed until the next
  config read found the broken file still in place.
- `fix/gateway-silent-revocation-failures` — three bare catches around
  `socket.close()` in revocation loops. A device removal or shared-auth
  rotation that threw on close was swallowed, leaving the client
  authenticated past the point the admin thought they were kicked.
- `fix/gateway-device-token-rpc-revalidation` — rotate/revoke responded
  OK before the microtask-scheduled disconnect, and there is no per-RPC
  re-check for device-token auth on `main` (only for shared-auth).
  Pipelined RPCs could therefore land with the rotated token. The PR
  proposes a synchronous `invalidated` flag plus a dispatcher-level
  guard; until it lands, **treat rotate/revoke as best-effort, not
  race-safe**.

The common pattern: **a privileged operation claims success before the
security guarantee is actually established.** Watch for it in reviews of
any method in this directory.

## Verification

- If you touch `secrets.ts`, also re-read `src/secrets/runtime.ts` and
  `src/secrets/resolve.ts` to confirm the downstream contracts you rely
  on are still upheld.
- Run `pnpm plugin-sdk:api:gen/check` after any change to the secrets
  payload schema — 60+ files in `src/` and ~20 extensions import from
  `src/secrets/`, and the runtime-deps manifest for each affected plugin
  may need regeneration. The `secrets → package` co-modification edge is
  weight 24 historically; treat a bigger-than-expected diff here as the
  norm, not a surprise.
