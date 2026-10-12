# Test Rules

- `unit-fast` fake-timer tests → `vitest.unit-fast-fake-timers`: parallel `unit-fast` uses `isolate: false`; shared timer globals can hang real-timer tests.
- Async E2E waits: produced state, never action return. Never substitute longer timeouts, sleeps, downstream assertion retries, or trimmed expectations.
