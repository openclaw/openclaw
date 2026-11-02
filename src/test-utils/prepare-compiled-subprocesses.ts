// Side-effect import for suites that re-import their subject per test (vi.resetModules,
// vi.doMock). Loading a compiled-subprocess declaration runs the invocation's one-time
// worker preparation at collection instead of inside the first test or hook deadline.
import "../infra/runtime-process-entrypoints.js";
