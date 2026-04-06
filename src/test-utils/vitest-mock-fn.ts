// Centralized Vitest mock type for harness modules under `src/`.
// Using an explicit named type avoids exporting inferred `vi.fn()` types that can trip TS2742.
// Test harnesses need a permissive default callable shape so vi.fn() can stand in for many signatures.
// oxlint-disable-next-line typescript/no-explicit-any
export type MockFn<T extends (...args: any[]) => unknown = (...args: any[]) => unknown> =
  import("vitest").Mock<T>;
