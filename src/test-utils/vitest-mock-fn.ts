// Centralized Vitest mock type for harness modules under `src/`.
// Using an explicit named type avoids exporting inferred `vi.fn()` types that can trip TS2742.
//
// oxlint-disable-next-line typescript/no-explicit-any
export type MockFn<T extends (...args: any[]) => any = (...args: any[]) => any> =
  import("vitest").Mock<T>;
