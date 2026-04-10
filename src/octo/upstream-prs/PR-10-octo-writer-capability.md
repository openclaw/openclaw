# Upstream PR 10 — Recognize `octo.writer` capability on device tokens and gate `octo.*` side-effects

**Status:** draft (M0-24). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target files:**

- `src/gateway/operator-scopes.ts` (capability literal)
- `src/gateway/method-scopes.ts` (dispatch-time authorization gate + loopback auto-grant)
  **Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Add `octo.writer` as a recognized operator capability (scope) on device tokens and enforce it at dispatch time for side-effecting Octopus Orchestrator methods. Device tokens already carry a list of capability strings via the existing operator-scope mechanism (`ADMIN_SCOPE`, `READ_SCOPE`, `WRITE_SCOPE`, `APPROVALS_SCOPE`, `PAIRING_SCOPE`, `TALK_SECRETS_SCOPE` in `src/gateway/operator-scopes.ts`). This PR extends that set with one new literal, `operator.octo.writer`, and wires it into `method-scopes.ts` as the required scope for the five mutating `octo.*` methods. Read-only `octo.*` methods remain classified under the existing `READ_SCOPE` and are unchanged.

Calls that arrive over a loopback transport (`127.0.0.1` / `::1`) are auto-granted `octo.writer` at the authorization gate per OCTO-DEC-024, so the local `openclaw` CLI continues to work without the operator having to re-provision their own device token with a new scope.

## Rationale

- **Authorization separation of concerns.** The Gateway's device-token scope set is the canonical place to express "this caller is allowed to mutate Octopus control-plane state". Piggy-backing on `WRITE_SCOPE` would over-grant: a token minted for ordinary `send` / `chat.send` / `sessions.create` use should not implicitly gain the ability to spawn, checkpoint, or terminate arms. A distinct capability is the least-privilege answer.
- **Not the same as `tools.elevated`.** `tools.elevated` is an OpenClaw sandbox-breakout concept: it lets `exec` tool calls escape the default execution sandbox and is owned by the OpenClaw tools / auto-reply pipeline (`src/auto-reply/reply/reply-elevated.ts`, `src/agents/bash-tools.exec.ts`). It has nothing to do with Gateway method authorization. `octo.writer` is a separate Octopus control-plane capability checked at Gateway method dispatch. An earlier revision of the Octopus HLD and DECISIONS log conflated the two; OCTO-DEC-029 explicitly supersedes that language and records that `tools.elevated` and `octo.writer` are distinct. This PR is one side of landing that correction in code.
- **Loopback auto-grant preserves the local CLI UX.** Per OCTO-DEC-024, any call received on the loopback interface is treated as originating from the same-host operator and is auto-granted `octo.writer` at the dispatch gate. This matches how the existing `openclaw` CLI already assumes a trusted local socket for admin operations and avoids forcing the operator to re-mint or re-scope their device token just to use `octo` commands from the same machine. Remote callers (Tailscale, LAN, public) are always gated by the explicit capability on the presented device token.
- **Dispatch-time, not listing-time.** Method-name visibility in `listGatewayMethods()` is unaffected by this PR (that is PR 1 / M0-15). A caller without `octo.writer` can still SEE the method names; they simply get a structured authorization error if they try to CALL a side-effecting one. This mirrors the existing behavior for `PAIRING_SCOPE` and `ADMIN_SCOPE`.
- **Read-only methods stay in `READ_SCOPE`.** `octo.arm.attach`, `octo.arm.health`, and `octo.node.capabilities` are read-only; they are classified under the existing `READ_SCOPE` via the standard `METHOD_SCOPE_GROUPS` map in `method-scopes.ts` and do NOT require `octo.writer`. Only the five mutators (`octo.arm.spawn`, `octo.arm.send`, `octo.arm.checkpoint`, `octo.arm.terminate`, `octo.node.reconcile`) are gated behind the new capability.

## Expected changes

Two files:

1. **`src/gateway/operator-scopes.ts`** — add one literal and extend the `OperatorScope` union:
   - `export const OCTO_WRITER_SCOPE = "operator.octo.writer" as const;`
   - Append `| typeof OCTO_WRITER_SCOPE` to the `OperatorScope` union.

2. **`src/gateway/method-scopes.ts`** — three edits:
   - Re-export `OCTO_WRITER_SCOPE` alongside the other scope re-exports.
   - Add an `[OCTO_WRITER_SCOPE]` entry to `METHOD_SCOPE_GROUPS` listing the five mutating methods.
   - Extend `authorizeOperatorScopesForMethod` (or a thin wrapper called from the dispatcher) with a loopback auto-grant: when the resolved required scope is `OCTO_WRITER_SCOPE` and the caller's transport is loopback, treat the call as authorized without requiring the scope on the token.

The loopback hint is already available at the dispatch site — `src/gateway/call.ts` has the connection's peer address via the `ws-connection` auth-context — so no new plumbing is required. This PR adds an optional `isLoopback` parameter to `authorizeOperatorScopesForMethod` and the call site passes it through.

Note for reviewers: the patch below shows the capability literal and the method-scope map changes. The dispatch-site call-through (`call.ts` passing `isLoopback` into the authorizer) is a mechanical one-line change at the existing `authorizeOperatorScopesForMethod` call and is shown inline in the patch for completeness.

## Diff preview

See `PR-10.patch` for the full unified diff.

## Test plan

- `pnpm test` — existing scope-authorization tests must continue to pass unchanged.
- New unit test in `method-scopes.test.ts` (or equivalent): a token with `[READ_SCOPE]` calling `octo.arm.spawn` gets a `missingScope: OCTO_WRITER_SCOPE` result.
- New unit test: a token with `[READ_SCOPE, OCTO_WRITER_SCOPE]` calling `octo.arm.spawn` is authorized.
- New unit test: a token with `[ADMIN_SCOPE]` calling `octo.arm.spawn` is authorized (ambient admin override path is unchanged).
- New unit test: calling `octo.arm.spawn` with `isLoopback: true` is authorized regardless of the token's scopes (OCTO-DEC-024 loopback auto-grant).
- New unit test: a token with `[READ_SCOPE]` calling `octo.arm.health` is authorized (health is read-only, `READ_SCOPE`, `OCTO_WRITER_SCOPE` not required).
- Integration: a remote (non-loopback) call with a device token lacking `octo.writer` to `octo.arm.spawn` receives a structured authorization error; the same call from a loopback client succeeds.

## Rollback plan

Revert both file edits. The scope literal is unused elsewhere in the codebase (the Octopus wire schemas don't reference it), and no persisted data (device-token database rows) depends on the literal existing, because tokens carrying the scope simply no longer match anything and fall through to the default-deny path. Existing tokens without the scope are unaffected.

## Dependencies on other PRs

- Logically depends on PR 1 / M0-15 (`octo.*` names registered in `server-methods-list.ts`) — without the names being listed, the dispatcher classification path for `octo.arm.spawn` etc. never runs.
- Paired with PR 7 / M0-17 (`caps.octo` connect-time capability exchange): M0-17 is about how an OpenClaw NODE advertises its Octopus capability to the Gateway at `connect`; M0-24 (this PR) is about how an OPERATOR's device token is authorized to invoke Octopus control-plane methods at the Gateway. The two capabilities live on different sides of the wire and do not overlap — an operator with `octo.writer` still cannot spawn an arm if no connected node reports `caps.octo: true`.
- Not blocked by any other PR in the wave.

## Reviewer guidance

Reviewer does NOT need to understand the full Octopus arm / lease / checkpoint model. The only questions are:

1. "Is a new operator scope literal the right shape for expressing Octopus control-plane authorization?" — yes, it matches the existing `PAIRING_SCOPE` / `APPROVALS_SCOPE` pattern.
2. "Is loopback auto-grant safe?" — yes, the Gateway already trusts loopback for several admin surfaces and the operator is, by definition, on the local host.
3. "Does this conflict with `tools.elevated`?" — no. `tools.elevated` is an entirely separate concept owned by the OpenClaw tools pipeline (exec sandbox breakout). They share no code paths and are recorded as distinct in OCTO-DEC-029.

For full Octopus context: `docs/octopus-orchestrator/HLD.md` (§Operator authorization), `docs/octopus-orchestrator/DECISIONS.md` (OCTO-DEC-024 loopback auto-grant, OCTO-DEC-029 `tools.elevated` vs `octo.writer` supersession), `docs/octopus-orchestrator/INTEGRATION.md` (§Required Upstream Changes row 4).
