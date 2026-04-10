# Upstream PR 4 — Register `/octo` slash command in the chat command registry

**Status:** draft (M0-18). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/auto-reply/commands-registry.shared.ts`
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Register `/octo` in OpenClaw's central chat command registry (`buildBuiltinChatCommands()`) so the in-chat operator surface described in `docs/octopus-orchestrator/INTEGRATION.md` §In-chat operator surface is dispatchable from every channel that consumes the shared registry (Discord, Telegram, WebChat, TUI). The command exposes the Octopus Orchestrator control plane through a single native name (`octo`) with an `action` argument whose `choices` enumerate the documented subcommands: `status`, `missions`, `mission`, `arms`, `arm`, `attach`, `unattach`, `tail`, `events`, `help`.

This PR only adds the REGISTRATION entry. The actual handler lands in a later octo-internal milestone and will live at `src/octo/cli/slash-commands.ts`. Until the handler is wired, invocations of `/octo` dispatch through the registry but return a structured error from the fallback path: `not_enabled` when `octo.enabled: false` (per OCTO-DEC-027), or `not_implemented` when enabled but no handler is attached yet.

## Rationale

- **Single registration point.** `buildBuiltinChatCommands()` in `src/auto-reply/commands-registry.shared.ts` is the canonical registry for built-in slash commands. Every channel (Discord, Telegram, WebChat, TUI) consumes it, so adding `/octo` here gives the command uniform availability without per-channel edits.
- **Matches existing operator-surface pattern.** `/subagents`, `/acp`, `/focus`, `/unfocus`, `/kill`, and `/steer` are already registered here with the same `action` + `target` + `value` shape. The Octopus in-chat operator surface is intentionally modeled after this pattern (HLD §Attach semantics reuse existing `/focus`/`/unfocus` thread-binding pattern), so `/octo` slots in naturally.
- **Attach semantics live on the octo handler, not in the registry.** Per OCTO-DEC-032, `/octo attach <arm_id>` binds the thread to an arm via agent handler state, NOT channel bindings. The registry only advertises the command; the handler owns the state transition. Nothing in this PR touches `/focus`/`/unfocus` or channel binding tables.
- **Feature-flag gating happens at dispatch, not at registration.** Matching the pattern used by PR 1 for `octo.*` methods: the command name is registered unconditionally so every tool that enumerates the registry (help, commands listing, autocomplete menus) sees it. Runtime gating (`octo.enabled`) is enforced by the handler.
- **No behavior change for `octo.enabled: false` deployments.** The only observable effect is that `/octo` appears in `/commands` output and tab-complete. Invocation returns a structured `not_enabled` error until the operator opts in.

## Expected changes

One edit to `src/auto-reply/commands-registry.shared.ts`:

1. **Add a `defineChatCommand({ key: "octo", ... })` entry** inside the `commands` array in `buildBuiltinChatCommands()`, placed adjacent to the other operator-surface commands (`subagents`, `acp`, `focus`, `unfocus`, `agents`, `kill`, `steer`). Reviewer suggestion: insert immediately after the `subagents` block to keep orchestration-adjacent commands grouped.

The `action` argument enumerates the documented subcommands per INTEGRATION.md §In-chat operator surface. `target` captures the id/template argument for `mission`, `arm`, `arm kill`, `attach`, `tail`, `mission create`. `value` captures any trailing free-text (captureRemaining) so composite subcommands like `arm kill <id>` and `mission create <template>` parse cleanly without adding a separate argument slot per variant.

No changes to `assertCommandRegistry()`, `registerAlias()`, or the builder's return shape. No new files in this PR — the handler file (`src/octo/cli/slash-commands.ts`) is a separate milestone.

## Diff preview

```diff
--- a/src/auto-reply/commands-registry.shared.ts
+++ b/src/auto-reply/commands-registry.shared.ts
@@ -337,6 +337,38 @@ export function buildBuiltinChatCommands(): ChatCommandDefinition[] {
       ],
       argsMenu: "auto",
     }),
+    defineChatCommand({
+      key: "octo",
+      nativeName: "octo",
+      description:
+        "Octopus Orchestrator operator surface: missions, arms, attach, tail, events.",
+      textAlias: "/octo",
+      category: "management",
+      args: [
+        {
+          name: "action",
+          description: "Octopus subcommand",
+          type: "string",
+          preferAutocomplete: true,
+          choices: [
+            "status",
+            "missions",
+            "mission",
+            "arms",
+            "arm",
+            "attach",
+            "unattach",
+            "tail",
+            "events",
+            "help",
+          ],
+        },
+        {
+          name: "target",
+          description: "Mission id, arm id, or template name",
+          type: "string",
+        },
+        {
+          name: "value",
+          description: "Additional arguments (e.g. 'kill' for arm kill)",
+          type: "string",
+          captureRemaining: true,
+        },
+      ],
+      argsMenu: "auto",
+    }),
     defineChatCommand({
       key: "acp",
       nativeName: "acp",
```

## Test plan

- `pnpm test` — existing tests for `buildBuiltinChatCommands()` / `assertCommandRegistry()` must continue to pass. The assertion pass will fail loudly on any duplicate key, duplicate native name, or duplicate text alias — a useful smoke test for the insertion.
- Extend `src/docs/slash-commands-doc.test.ts` (or the nearest equivalent inventory test) to assert that `octo` is present in the registry and exposes the documented `action` choices.
- Manual: in a local build with `octo.enabled: false`, typing `/octo` in the TUI and in a Discord/Telegram channel should (a) surface `/octo` in `/commands` output and autocomplete, and (b) return a structured `not_enabled` error when invoked (via the handler's fallback path, landing in a later PR).
- Manual: in a local build with `octo.enabled: true` but no handler attached, invocation must return a `not_implemented` error rather than crashing the dispatcher.

## Rollback plan

Revert the single `defineChatCommand({ key: "octo", ... })` insertion. No other files are touched, so rollback is a clean revert with no ordering dependency on other PRs in the wave.

## Dependencies on other PRs

- Logically depends on PR 1 (M0-15) for the `octo.*` gateway method surface, since the eventual `/octo` handler will call those methods. The registration itself does NOT require PR 1 to land first — an unwired `/octo` command cleanly returns a fallback error.
- Does NOT depend on PR 2 or PR 3. Registration is independent of dispatcher wiring.

## Reviewer guidance

The reviewer does NOT need to understand the full Octopus Orchestrator design to merge this PR. The only question is: "is it OK to reserve `/octo` as a built-in command name in the shared registry, with a stub handler path landing in a later PR?" The command shape (`action` + `target` + `value`) mirrors the existing `/subagents` and `/acp` entries, so the diff should read as a mechanical addition in the same style.

Possible ambiguity: the registry file (`src/auto-reply/commands-registry.shared.ts`) is the clearest central registration point, but per-channel plugins (`src/channels/plugins/**`) also surface slash commands via adapters. Those adapters consume this shared registry, so a single edit here is sufficient for the name to propagate — reviewer should confirm that remains true at the current `main` tip before merging.

For full Octopus context: `docs/octopus-orchestrator/INTEGRATION.md` §In-chat operator surface, `docs/octopus-orchestrator/HLD.md` §Attach semantics, `docs/octopus-orchestrator/DECISIONS.md` (OCTO-DEC-027 feature flag, OCTO-DEC-032 thread-to-arm attach on handler state).
