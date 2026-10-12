# Test Rules

- Put `unit-fast` fake-timer tests in `vitest.unit-fast-fake-timers`: parallel `unit-fast` uses `isolate: false`; shared timer globals can hang real-timer tests.
- Async E2E waits target the produced state, never action return. Do not substitute longer timeouts, sleeps, downstream assertion retries, or trimmed expectations.
