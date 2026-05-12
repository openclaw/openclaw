# Audit Evidence Fixtures

These files capture real `openclaw security audit --json` behavior for the
gateway bind classifier scenarios discussed in PR #70368.

Regenerate them from the repository root:

```sh
./tools/audit-evidence/capture.sh
```

The script runs each audit against a temporary `OPENCLAW_CONFIG_PATH`,
`OPENCLAW_STATE_DIR`, and `OPENCLAW_HOME`, then redacts repository, temporary,
and home paths in the JSON output. It prefers `pnpm openclaw`; if `pnpm` is not
available in the local sandbox, it falls back to the source entrypoint with
`node --import tsx src/entry.ts`.

The `auto-bind-resolves-0.0.0.0.json` case uses a temporary Node preload to make
the process look containerized, which drives the same `auto -> 0.0.0.0` resolver
branch used at runtime.
