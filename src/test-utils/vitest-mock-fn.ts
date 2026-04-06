// Centralized Vitest mock type for harness modules under `src/`.
// Using an explicit named type avoids exporting inferred `vi.fn()` types that can trip TS2742.
//
export type MockFn<T extends (...args: never[]) => unknown = (...args: never[]) => unknown> =
  import("vitest").Mock<T>;
