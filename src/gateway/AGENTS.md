# Gateway Working Guide

This guide applies to `src/gateway/**` unless a deeper `AGENTS.md` overrides it.

## Hooks and Webhook Parity

- Keep hook auth behavior consistent across hook routes.
- Accept hook tokens only from `Authorization: Bearer` or `X-OpenClaw-Token`.
- Reject query-string token auth on all hook routes.
- Reuse shared constant-time secret checks and shared auth-failure rate-limit buckets.
- Reuse shared client IP resolution (trusted proxy handling and fallback rules).

## Request Safety and Replay Protection

- Keep hook routes `POST`-only unless a route explicitly documents another method.
- Reuse shared JSON body guards (size limit and timeout) instead of adding per-route readers.
- Reuse existing hook idempotency extraction and replay cache behavior.
- When adding a new idempotent hook payload, include a deterministic fallback key when no idempotency header is present.

## Hook Message Ingress Conventions

- Validate hook payloads at ingress with strict required/optional contracts.
- For inbound message hooks, preserve `requestId` and session resolution deterministically.
- Keep lifecycle logs deterministic with stable field order and stable event names.
- Do not leak raw internal exceptions to hook clients; return generic 5xx errors and log details server-side.
- Keep route responsibility explicit:
  - `/hooks/agent` is automation execution only.
  - `/hooks/message` is inbound chat visibility transport.

## Test Expectations

- Add parity tests for auth and request guards when introducing new hook paths.
- Cover idempotent replay behavior for retries.
- Cover `kind`-specific behavior for message vs event payloads.
- For webchat visibility tests, assert the live chat event path and auto-reply dispatch invocation for active sessions.
