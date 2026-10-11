# Deferred storage cleanup

## Heartbeat outcome table

[Heartbeat retirement](https://github.com/openclaw/openclaw/issues/134994) leaves
`heartbeat_outcomes` in the per-agent schema. Its runtime readers and writers are
retired; Doctor transfers still-relevant pending outcomes idempotently into
ordinary session context before removing each verified source row. Existing
session deletion and retention continue to own the remaining inert rows.

Keep agent schema 25 during this cutover, without an additional agent migration.
Removing the table requires a separately approved agent-schema migration; the
shared-state policy fence does not authorize that cleanup. Its owner must remove
the table declaration, generated types, and
schema-fragment delimiters in `openclaw-agent-session-sharing-schema.ts` and
`openclaw-agent-progress-card-schema.ts` together.

Before removal, prove copied populated and empty database migration, interrupted
context transfer without duplicate context, candidate reopen and integrity,
session-data preservation, and older-reader refusal. Recover by restoring a
verified WAL-aware pre-upgrade backup into a separate state directory with the
matching build, never by lowering version markers or reconstructing discarded data.
