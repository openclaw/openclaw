# Populated prior-release state corpus

Each directory is a complete state directory written by a released OpenClaw:
the release's own storage writers (imported from the tag's `src/`) and its own
CLI (`setup`, `agents add`, `approvals allowlist add`, `plugins install`,
`backup create`). Generation ran in `node:24.22.1-trixie` with `--network none`,
uid 1000, `HOME=/home/fixture` and no host `OPENCLAW_*` environment. All
credentials are fake. Snapshots were copied after every writer exited.

| Fixture         | Release tag   | Shared schema | Agent schema |
| --------------- | ------------- | ------------- | ------------ |
| `2026.7.1`      | `v2026.7.1`   | 1             | 1            |
| `2026.7.1-blob` | `v2026.7.1`   | 1             | 1            |
| `2026.7.35`     | `v2026.7.35`  | 1             | 1            |
| `2026.8.35`     | `v2026.8.35`  | 15            | 19           |
| `2026.9.37`     | `v2026.9.37`  | 19            | 24           |
| `2026.10.10`    | `v2026.10.10` | 22            | 27           |

`-blob` is the same snapshot with every TEXT value in non-STRICT tables stored as
a BLOB (issue #110186), produced by Python's `sqlite3`, not OpenClaw code.

`manifest.json` records the source commit, the expected values each surface
wrote, and where each value was found (`verification`). Paths inside the
databases and `openclaw.json` still name `/home/fixture`; tests rewrite the
config to their temporary directory.

Consumers: `src/state/sqlite-copy-swap.test.ts` (generic rebuild) and
`test/state-upgrade.e2e.test.ts` (Gateway start on each release).
