# Upstream PR 9 — Register `octo_*` agent tools in `tool-catalog.ts`

**Status:** draft (M0-23). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/agents/tool-catalog.ts`
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Register the 16 Octopus Orchestrator agent tools (`octo_status`, `octo_mission_*`, `octo_arm_*`, `octo_grip_*`, `octo_events_tail`, `octo_claims_list`) in the canonical OpenClaw agent tool catalog. The catalog drives profile-based allowlisting (`minimal` / `coding` / `messaging`), the `group:openclaw` umbrella, and the UI surface that shows users which tools an agent can call.

Tool parameter schemas already exist — singly-sourced in `src/octo/tools/schemas.ts` as `OCTO_TOOL_SCHEMA_REGISTRY` — and are iterated by the test sweep in `src/octo/tools/schemas.test.ts`. This PR wires that registry's tool NAMES into the catalog so natural-language agents can actually invoke Octopus from a tool call.

Tool factory creation (the `createOcto*Tool` functions that turn each registry entry into an `AnyAgentTool` suitable for `createOpenClawTools` in `src/agents/openclaw-tools.ts`) is NOT in this PR — that wiring lands in a later milestone and is additive on top of the catalog registration. Registering the names here is a prerequisite: without it, even correctly-implemented factory functions would be filtered out by the profile-based allowlist pipeline in `src/agents/tool-policy-pipeline.ts`.

## Rationale

- **Catalog is the allowlist gate.** Every tool passes through `applyToolPolicyPipeline` in `src/agents/tool-policy-pipeline.ts`, which consults the `coding` / `messaging` / `minimal` profiles in `CORE_TOOL_PROFILES`. A tool absent from `CORE_TOOL_DEFINITIONS` cannot appear in any built-in profile's `allow` list. Without catalog registration, agents with a profile set would silently drop octo tools regardless of what the factory returns.
- **Read-only vs writer partition lives in profile membership.** Per `docs/octopus-orchestrator/INTEGRATION.md` §1 Agent tool surface and OCTO-DEC-028, the 8 read-only octo tools ship in the default allowlist for any agent with Octopus enabled, and the 8 writer tools are opt-in (requires explicit `tools.allow` in `openclaw.json`). The catalog expresses this cleanly: read-only tools get `profiles: ["minimal", "coding", "messaging"]` (joining the same profiles any typical agent already uses), writer tools get `profiles: []` (never in a built-in profile, must be explicitly allowed by name).
- **`tools.elevated` is NOT the writer gate.** Per OCTO-DEC-029, `tools.elevated` in OpenClaw is specifically about sandbox breakout for `exec` and must not be overloaded. The writer tools' second gate — beyond `tools.allow` — is the `octo.writer` device-token capability added by upstream PR 10 (M0-24). This PR does NOT touch `tools.elevated` and does NOT introduce a new elevation class. The writer partition is expressed purely by absence from profiles, not by any "elevated" flag.
- **One source of truth.** Tool names come from `OCTO_TOOL_NAMES` in `src/octo/tools/schemas.ts`. The catalog entries list them verbatim so there is no string drift between the schemas registry, tests, and the catalog. The TODO in `schemas.ts` (lines 37–41, `M1-14`) is discharged by this PR.
- **`includeInOpenClawGroup: true`** on read-only tools extends `group:openclaw` — the umbrella an operator writes as `tools.allow: ["group:openclaw"]` to opt into "everything OpenClaw ships". Writer tools are deliberately excluded from this umbrella so operators who want read observability get it without accidentally enabling mission abort / arm termination.
- **No behavior change when `octo.enabled: false`.** Catalog entries do not call into any octo subsystem — they are metadata. The tool factories that consume them fail closed if the octo subsystem is off. With `octo.enabled: false` (the default through Milestone 1), the factories return no tools and the catalog entries are inert.

## Expected changes

Two edits to `src/agents/tool-catalog.ts`:

1. **Add 16 entries** to `CORE_TOOL_DEFINITIONS`, one per octo tool. Section id `sessions` for the list/show/events/claims tools (they read from mission/arm state), section id `automation` for the mission/arm/grip writer tools (they mutate control-plane state the same way `cron` and `gateway` do). No new section is introduced — the existing `automation` and `sessions` sections already accommodate control-plane tools.
2. **Optional (tests-only):** extend `src/agents/tool-catalog.test.ts` to assert that `OCTO_READ_ONLY_TOOL_NAMES` is a subset of `listCoreToolIdsForProfile("coding")` and that `OCTO_WRITER_TOOL_NAMES` are all `profiles: []`. This catches drift if someone later flips a writer tool into a profile. This assertion lives in the octo test sweep (`src/octo/tools/schemas.test.ts`) rather than the core catalog test to keep the upstream test file change-free.

## Tool table

Read-only (default allowlist, `profiles: ["minimal", "coding", "messaging"]`, `includeInOpenClawGroup: true`):

| Tool name           | Section    | Wraps               |
| ------------------- | ---------- | ------------------- |
| `octo_status`       | `sessions` | `octo.status`       |
| `octo_mission_list` | `sessions` | `octo.mission.list` |
| `octo_mission_show` | `sessions` | `octo.mission.show` |
| `octo_arm_list`     | `sessions` | `octo.arm.list`     |
| `octo_arm_show`     | `sessions` | `octo.arm.show`     |
| `octo_grip_list`    | `sessions` | `octo.grip.list`    |
| `octo_events_tail`  | `sessions` | `octo.events.tail`  |
| `octo_claims_list`  | `sessions` | `octo.claims.list`  |

Writer (opt-in, `profiles: []`, NOT in `group:openclaw`):

| Tool name             | Section      | Wraps                 |
| --------------------- | ------------ | --------------------- |
| `octo_mission_create` | `automation` | `octo.mission.create` |
| `octo_mission_pause`  | `automation` | `octo.mission.pause`  |
| `octo_mission_resume` | `automation` | `octo.mission.resume` |
| `octo_mission_abort`  | `automation` | `octo.mission.abort`  |
| `octo_arm_spawn`      | `automation` | `octo.arm.spawn`      |
| `octo_arm_send`       | `automation` | `octo.arm.send`       |
| `octo_arm_terminate`  | `automation` | `octo.arm.terminate`  |
| `octo_grip_reassign`  | `automation` | `octo.grip.reassign`  |

Operators who want the full writer surface must set, per-agent:

```json
{
  "tools": {
    "allow": [
      "group:openclaw",
      "octo_mission_create",
      "octo_mission_pause",
      "octo_mission_resume",
      "octo_mission_abort",
      "octo_arm_spawn",
      "octo_arm_send",
      "octo_arm_terminate",
      "octo_grip_reassign"
    ]
  }
}
```

AND the operator device token must carry the `octo.writer` capability (added by PR 10, M0-24). Both gates are required. The catalog expresses the first gate; the capability gate is enforced at dispatch inside the Head per OCTO-DEC-024 / OCTO-DEC-029.

## Test plan

- `pnpm test src/agents/tool-catalog.test.ts` — existing catalog tests must continue to pass. The 16 new entries extend `CORE_TOOL_DEFINITIONS` without reshaping existing rows.
- `pnpm test src/octo/tools/schemas.test.ts` — the schemas sweep asserts the read-only / writer partition at the `OCTO_TOOL_SCHEMA_REGISTRY` layer. Extend it to additionally cross-check `tool-catalog.ts` profile membership so future edits cannot desync the two files.
- Manual: with `octo.enabled: true` and a `coding`-profile agent, `openclaw agent run` followed by an octo tool call must resolve the tool name through the allowlist pipeline without a "tool not allowed by policy" warning. With `octo.enabled: false`, the same call must fail closed at the factory layer, not at the catalog layer.

## Rollback plan

Revert the `CORE_TOOL_DEFINITIONS` additions. No other file in `src/agents/` depends on octo tool names, so rollback is strictly removing 16 object literals from the catalog array. The `OCTO_TOOL_SCHEMA_REGISTRY` in `src/octo/tools/schemas.ts` stays in place unaffected.

## Dependencies on other PRs

- **Depends on:** M0-08 (`src/octo/tools/schemas.ts` — the `OCTO_TOOL_SCHEMA_REGISTRY` used as the source of truth for names). Already landed.
- **Depends on:** M0-15 (upstream PR 1 drafting convention). Already landed.
- **Related:** M0-24 (upstream PR 10) adds the `octo.writer` device-token capability. This PR 9 does NOT require PR 10 to merge first — catalog entries are inert until factories land. But operators cannot successfully CALL writer tools until PR 10 is in place. The two PRs are independent in the file-change sense and coupled in the runtime-behavior sense.
- **Related:** future milestone PR adds the `createOcto*Tool` factories under `src/agents/tools/` and invokes them from `createOpenClawTools` in `src/agents/openclaw-tools.ts`. That PR depends on this one.

## Reviewer guidance

Reviewer does NOT need to read the Octopus HLD or understand mission semantics to merge this PR. The only question is: "should the 16 tool names listed in `OCTO_TOOL_NAMES` appear in `CORE_TOOL_DEFINITIONS`, with read-only names joining existing profiles and writer names marked `profiles: []`?" The answer is yes because:

- The alternative is a parallel catalog maintained inside `src/octo/`, which drifts from the upstream profile pipeline.
- Absence from the catalog is silent: agents drop the tools without a warning, making the bug impossible to diagnose from the operator's side.
- The read-only vs writer partition maps cleanly onto the existing `profiles` field — no new field, no new policy stage.

For full Octopus context: `docs/octopus-orchestrator/INTEGRATION.md` §Agent tool surface, `docs/octopus-orchestrator/DECISIONS.md` OCTO-DEC-028 (tool surface rationale) and OCTO-DEC-029 (`tools.elevated` is not the writer gate).
