# Upstream PR 3 — Accept `capsOcto` on `role: node` connect

**Status:** draft (M0-17). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/gateway/protocol/schema/frames.ts` (schema), `src/gateway/node-registry.ts` (session storage + query surface)
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Let a node advertise Octopus Orchestrator host capabilities during the Gateway connect handshake. A node running an Octopus Node Agent attaches a `capsOcto` object to its `connect` params describing the octo wire protocol version, the set of runtime adapters it can host, and its max concurrent arm count. The Gateway's connect-params schema validator recognizes this new optional field, `NodeRegistry.register()` stores it on the `NodeSession`, and scheduler code reads it through the existing `listConnected()` / `get()` query surface to filter nodes eligible for octo placement.

This PR only lights up the capability declaration channel. Dispatch of `octo.*` RPCs and lease/arm bookkeeping are separate PRs.

## Rationale

- **Capability-scoped Node Agents.** Per HLD §Security model, the Head must know which connected nodes can host octo arms before placing work on them. A node without an Octopus Node Agent installed still participates in the classic OpenClaw node protocol (device invoke, wake, etc.) exactly as today, and must not be offered octo placement. The `capsOcto` field is how a node says "yes, I can host arms."
- **Purely additive schema change.** The existing `caps` field in `ConnectParamsSchema` is a flat `Type.Array(NonEmptyString)` of legacy capability flags. We do NOT change its shape, do not re-home any existing key, and do not rename anything. The new field is a new optional sibling, `capsOcto`, with its own object schema. Nodes that never send it are unaffected (the Gateway validates, stores `undefined`, and the scheduler simply does not consider them octo-eligible). The JSON example in the integration spec (`caps.octo.*`) is aspirational naming; the wire field is flattened to `capsOcto` to avoid overloading the existing `caps` array and to keep the diff surgical.
- **Connect-time acceptance is independent of `octo.enabled`.** Even a Gateway running with `octo.enabled: false` accepts and stores `capsOcto` from a connecting node. It simply never routes any `octo.*` traffic through that node because the dispatcher returns `not_enabled`. This matters because a single node may connect to multiple heads (per HLD §Federation), some of which have octo turned on and some of which do not; the wire protocol must be forward-compatible on every head the node can reach. Rejecting `capsOcto` on non-octo heads would require nodes to dual-format their connect payloads per-target, which breaks the "one node, many heads" posture.
- **Query surface is already sufficient.** `NodeRegistry.listConnected()` and `NodeRegistry.get(nodeId)` already expose the full `NodeSession` to callers. Adding `capsOcto?: NodeCapsOcto` to the `NodeSession` type makes it visible to any scheduler filter without introducing a new API method. Scheduler code (landing in a later milestone) will do a simple `registry.listConnected().filter((n) => n.capsOcto && n.capsOcto.maxArms > 0)` — no new plumbing required.
- **Forward compatibility of `capsOcto` itself.** The field is versioned (`version: "1"`) and the `adapters` array is an open-ended list of adapter type names. Adding new adapter types (e.g., a future `wasm_sandbox`) does not require a schema change on the Gateway side — the validator accepts any non-empty string in the array and downstream scheduler code filters by the names it understands. `maxArms` has a floor of 0 so a node can advertise `{adapters: [...], maxArms: 0}` during drain-down without being removed from the registry.

## Expected changes

Two files touched:

1. **`src/gateway/protocol/schema/frames.ts`** — add `NodeCapsOctoSchema` (a new TypeBox object with `version`, `adapters`, and `maxArms` fields) and a new optional `capsOcto` entry in `ConnectParamsSchema`. No changes to existing keys.
2. **`src/gateway/node-registry.ts`** — add a `NodeCapsOcto` type alias (derived from the schema shape), extend the `NodeSession` type with `capsOcto?: NodeCapsOcto`, and populate it inside `register()` from `client.connect.capsOcto`. `listConnected()` and `get()` require no code changes; they already return the full `NodeSession`.

No changes to dispatch, no changes to the pairing / approval flow, no changes to `hello-ok`, no changes to any existing test.

## Diff preview

```diff
--- a/src/gateway/protocol/schema/frames.ts
+++ b/src/gateway/protocol/schema/frames.ts
@@ -18,6 +18,20 @@ export const ShutdownEventSchema = Type.Object(
   { additionalProperties: false },
 );

+// Octopus Orchestrator node-host capability declaration. Purely additive
+// — see upstream PR 3 rationale. A node running an Octopus Node Agent
+// attaches this to its connect params to signal "I can host octo arms."
+// Nodes that omit it are unaffected and remain non-octo-eligible.
+export const NodeCapsOctoSchema = Type.Object(
+  {
+    version: NonEmptyString,
+    adapters: Type.Array(NonEmptyString, { minItems: 1 }),
+    maxArms: Type.Integer({ minimum: 0 }),
+  },
+  { additionalProperties: false },
+);
+
 export const ConnectParamsSchema = Type.Object(
   {
     minProtocol: Type.Integer({ minimum: 1 }),
@@ -38,6 +52,7 @@ export const ConnectParamsSchema = Type.Object(
     permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
     pathEnv: Type.Optional(Type.String()),
     role: Type.Optional(NonEmptyString),
+    capsOcto: Type.Optional(NodeCapsOctoSchema),
     scopes: Type.Optional(Type.Array(NonEmptyString)),
     device: Type.Optional(
```

```diff
--- a/src/gateway/node-registry.ts
+++ b/src/gateway/node-registry.ts
@@ -1,6 +1,12 @@
 import { randomUUID } from "node:crypto";
 import type { GatewayWsClient } from "./server/ws-types.js";

+export type NodeCapsOcto = {
+  version: string;
+  adapters: string[];
+  maxArms: number;
+};
+
 export type NodeSession = {
   nodeId: string;
   connId: string;
@@ -16,6 +22,7 @@ export type NodeSession = {
   modelIdentifier?: string;
   remoteIp?: string;
   caps: string[];
+  capsOcto?: NodeCapsOcto;
   commands: string[];
   permissions?: Record<string, boolean>;
   pathEnv?: string;
@@ -70,6 +77,10 @@ export class NodeRegistry {
       modelIdentifier: connect.client.modelIdentifier,
       remoteIp: opts.remoteIp,
       caps,
+      capsOcto:
+        (connect as { capsOcto?: NodeCapsOcto }).capsOcto &&
+        typeof (connect as { capsOcto?: NodeCapsOcto }).capsOcto === "object"
+          ? (connect as { capsOcto?: NodeCapsOcto }).capsOcto
+          : undefined,
       commands,
       permissions,
       pathEnv,
```

## Test plan

- `pnpm test` — existing connect / pairing / node-registry unit tests must pass unchanged. No existing test sends `capsOcto`, so every current fixture continues to validate and to land in `NodeRegistry` with `capsOcto: undefined`.
- Add a new unit test in `src/gateway/node-registry.test.ts` (or the closest existing suite) that connects a node with a sample `capsOcto: { version: "1", adapters: ["cli_exec", "pty_tmux"], maxArms: 4 }` payload and asserts `registry.get(nodeId)?.capsOcto?.adapters` contains the expected adapter names.
- Add a schema-negative test: a connect payload with `capsOcto: { version: "1", adapters: [], maxArms: 4 }` must be rejected (`minItems: 1` on adapters), and `capsOcto: { version: "1", adapters: ["x"], maxArms: -1 }` must be rejected (`minimum: 0`).
- Manual: point an Octopus Node Agent (once built) at a Gateway with `octo.enabled: false`. The connect must succeed and the node must appear in `openclaw node list` with its legacy fields intact. The node must NOT appear in `openclaw octo node list` (because that list is scheduler-filtered and the scheduler respects `octo.enabled`).

## Rollback plan

Revert both hunks. The `capsOcto` field is a new optional key; removing it returns the schema and `NodeSession` to their pre-PR shape. No stored state persists `capsOcto` across restarts (the registry is in-memory and populated from connect), so rollback does not require a data migration.

## Dependencies on other PRs

- None. This PR is independent of PR 1 (method list) and PR 2 (features builder). A Gateway can accept `capsOcto` without advertising any `octo.*` methods — the field is just stored. Dispatch and scheduler placement are later PRs that consume this data; they will soft-fail on Gateways without this PR applied because `registry.listConnected()[i].capsOcto` will always be `undefined` there.

## Reviewer guidance

Reviewer does NOT need to understand the full Octopus Orchestrator design to merge this PR. The questions are:

1. Is the schema addition purely additive? Yes — new optional field, no existing key touched.
2. Does the Gateway need to do anything with the data in this PR? No — store it and expose it through `NodeSession`. Consumption is out of scope.
3. Can a Gateway with `octo.enabled: false` safely accept this field? Yes, and it must, because nodes connect to multiple heads and the wire protocol must be forward-compatible per head.
4. Does this PR create any new surface that needs authorization? No — the node is already authenticated through the existing pairing flow before its connect params are parsed. Whether a given node is ALLOWED to host octo arms is a scheduler-time policy decision (see LLD §Placement policy), not a connect-time one.

For full Octopus context: `docs/octopus-orchestrator/HLD.md` §Security model and §OpenClaw Integration Foundation, `docs/octopus-orchestrator/INTEGRATION.md` §Remote habitat pairing and §Required Upstream Changes.
