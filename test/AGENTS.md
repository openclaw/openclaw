# Test Rules

- Fake timers: call `vi.useFakeTimers()` directly in the test file; the unit-fast classifier routes on that call into `vitest.unit-fast-fake-timers`. Parallel `unit-fast` uses `isolate: false`; shared timer globals can hang real-timer tests.
