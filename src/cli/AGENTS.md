# CLI Boundary

This directory owns command parsing, TTY UX, and thin command orchestration.
Most CLI files should stay decoupled from gateway transport internals.

## Source Of Truth

- CLI gateway seam:
  - `src/cli/gateway-rpc.ts`
  - `src/cli/gateway-rpc.runtime.ts`
  - `src/cli/logs-cli.runtime.ts`
- Gateway call surface:
  - `src/gateway/call.ts`
  - `src/gateway/client.ts`
- Shared CLI helpers:
  - `src/cli/progress.ts`
  - `src/cli/command-format.ts`
  - `src/terminal/*`

## Boundary Rules

- Default to `callGatewayFromCli(...)` plus `addGatewayClientOptions(...)` for
  one-shot gateway RPCs. Do not import `src/gateway/call.ts` directly from
  ordinary command handlers just to make a simple request.
- Keep heavyweight gateway imports behind a narrow runtime seam when possible.
  Prefer a local `*.runtime.ts` bridge over adding more top-level
  `../gateway/*` imports across the directory.
- Treat direct `GatewayClient` usage as an exception for commands that truly
  need a persistent WebSocket session or transport-level behavior, such as
  `logs --follow`. If another command needs that, add a focused local seam
  instead of copying transport setup inline.
- Do not import broad gateway/server implementation modules such as
  `src/gateway/server-methods/**`, `src/gateway/server/**`, or unrelated
  gateway internals into CLI files. If the CLI needs a new capability, expose
  it through `src/gateway/call.ts`, a focused runtime bridge, or an explicit
  protocol method.
- Keep parsing/help/option modules lightweight. Files that mostly define
  Commander options, help text, or output formatting should not gain direct
  WebSocket/client/config-loading imports.

## When Expanding The Boundary

- If many commands need the same gateway helper, add a local CLI seam instead
  of duplicating imports from `src/gateway/**`.
- If a command needs lazy loading for build or startup reasons, use a local
  `*.runtime.ts` file and have the command module dynamically import it.
- When adding a new seam, keep tests mocking the CLI-local bridge rather than
  reaching through to deep gateway internals unless the test is explicitly
  about transport behavior.
