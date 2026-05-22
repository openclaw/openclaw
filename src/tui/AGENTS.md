# TUI Notes

- Run `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts` for PTY coverage. It includes the real local-backend smoke test and the fast fake-backend terminal-loop tests.
- The local PTY smoke runs `tui --local` and mocks only the external model endpoint. The fake-backend lane runs the real `runTui()` loop with a fake `TuiBackend`.
- Do not claim the fake-backend PTY harness proves Gateway transport, embedded backend runtime, providers, session persistence, or live streaming.
- Prefer stable visible text and fixture backend call assertions. Avoid raw ANSI snapshots.
- Use `pnpm tui:pty:test:watch` to watch the fast fake-backend PTY test without mixing Vitest reporter output into the TUI screen. Use `--mode local` for the real local-backend lane or `--mode all` for both.
