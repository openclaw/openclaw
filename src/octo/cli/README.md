# Octopus CLI Commands (`src/octo/cli/`)

This directory holds the implementations of the `openclaw octo …` subcommands. Each file backs one top-level verb and turns operator input into `octo.*` Gateway requests, then renders the response for human or machine consumption. The CLI is the primary operator surface for Octopus during Milestones 1 through 4 before any GUI work.

Per HLD §"Code layout and module boundaries", the following command modules are planned:

- `octo-status.ts` — `openclaw octo status`: subsystem health and summary.
- `octo-arm.ts` — `openclaw octo arm …`: arm lifecycle (list, spawn, terminate, restart).
- `octo-mission.ts` — `openclaw octo mission …`: mission create/show/list operations.
- `octo-grip.ts` — `openclaw octo grip …`: grip inspection and reassignment.
- `octo-claims.ts` — `openclaw octo claims`: claim listing and resolution.
- `octo-events.ts` — `openclaw octo events --tail`: live event log tailing.
- `octo-node.ts` — `openclaw octo node …`: Node Agent listing and management.

No runtime code lives here yet. Side-effecting subcommands will require the `octo.writer` capability on the operator device token (with loopback auto-grant); read-only commands are available to any paired operator. See HLD §"Operator authorization".
