# Cron Runtime Guide

This guide applies to `src/cron/**` unless a deeper `AGENTS.md` overrides it.

## Delivery Responsibility

- Keep isolated-run execution separate from chat UI transport concerns.
- `deliveryContract="cron-owned"` may queue main-session awareness after successful direct delivery when policy allows.
- `deliveryContract="shared"` must not add extra main-session awareness mirrors; the caller owns any UI visibility behavior.

## Delivery Semantics

- `delivered` means the configured outbound delivery route completed for this run.
- `deliveryAttempted` tracks whether cron attempted the configured delivery path, even when the run result remains `ok`.
- Do not infer chat-UI mirroring from `delivered=true`.

## Reliability Rules

- Keep direct-delivery idempotency deterministic.
- Preserve best-effort behavior: never convert partial delivery into a cached full success.
- Keep stale-run suppression and no-reply suppression paths from triggering duplicate fallback announcements.

## Test Expectations

- Add or update tests when changing delivery contract branching.
- Verify both `cron-owned` and `shared` paths for awareness-queue side effects.
