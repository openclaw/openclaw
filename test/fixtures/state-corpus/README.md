# Prior-release state corpus

These databases were generated in an isolated account with fake credentials.
No live Gateway state or operator files were copied.

| Fixture            | Source                                                             | Shared schema | Agent schema |
| ------------------ | ------------------------------------------------------------------ | ------------- | ------------ |
| `2026.9.2`         | tag `v2026.9.2`, commit `3928bad9badfcb6c7d140530435e806fb8092190` | 15            | 19           |
| `2026.9.3-95f3ed9` | commit `95f3ed90285b73d50764ab6b670976fb7ca5d638`                  | 17            | 19           |

Each fixture contains two sessions with recognizable user messages, an API key
profile, an OAuth profile, a native CLI-shaped OAuth profile, a disabled cron
job, and a Control UI theme preference. `manifest.json` records the expected
values and source revision. The native CLI profile tests stored credential
metadata; it does not authenticate an external CLI.

`generate.mjs` calls each old checkout's maintained storage writers. Build and
run it on an isolated Linux host as the synthetic `fixture` user, with
`HOME=/home/fixture`, `OPENCLAW_STATE_DIR=/home/fixture/.openclaw`, and
`OPENCLAW_CONFIG_PATH=/home/fixture/.openclaw/openclaw.json`:

```sh
pnpm install
node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime
node openclaw.mjs setup --baseline --workspace /home/fixture/workspace --json
node --import ./scripts/tsx.mjs /path/to/generate.mjs "$PWD" <fixture-name> <output-dir>
```

Start each release from an empty synthetic state and workspace. The generator
closes database owners before copying the state directory. The fingerprint key
and any setup backup are generated fixtures too. Do not replace any file with
an operator's real state.

Inspect closed snapshots with SQLite URI options `mode=ro&immutable=1`.
A plain read-only open can create `-wal` and `-shm` sidecars beside a fixture.

Cron's released storage partition uses an absolute logical path. The generator
records that selection through `writeConfigMachineState("cron.store", ...)`,
so copying the fixture retains the selected partition without rewriting rows.
The state matrix skips Windows because these snapshots retain POSIX partition
keys; the required-fixture inventory check still runs on every platform.
Windows upgrade coverage requires state generated on Windows.
Both releases already use SQLite sessions. These snapshots cover real released
schemas, Doctor state migration, and credential preservation; they do
not claim coverage of pre-SQLite JSON transcript imports.

The startup suite copies each snapshot into a temporary directory and crosses
it with the config corpus. It runs explicit Doctor repair, startup admission,
session maintenance, credential loading, and static catalog preparation. It
checks record preservation and SQLite integrity twice to cover repeat repair.
