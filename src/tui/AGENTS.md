# TUI Notes

- Run `node scripts/run-vitest.mjs src/tui/tui-pty-local.test.ts` for real local-backend TUI smoke coverage. It runs `tui --local` and mocks only the external model endpoint.
- Run `node scripts/run-vitest.mjs src/tui/tui-pty-harness.test.ts` for fast terminal-loop coverage. It runs the real `runTui()` loop with a fake `TuiBackend`.
- Do not claim the fake-backend PTY harness proves Gateway transport, embedded backend runtime, providers, session persistence, or live streaming.
- Prefer stable visible text and fixture backend call assertions. Avoid raw ANSI snapshots.
- Use `pnpm tui:pty:test:watch` to watch the fast fake-backend PTY test without mixing Vitest reporter output into the TUI screen. Use `--mode local` for the real local-backend lane or `--mode all` for both.
