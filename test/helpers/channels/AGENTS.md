# Test Helper Boundary

This directory holds shared channel test helpers used by core and bundled plugin
tests.

## Bundled Plugin Imports

- Core test helpers in this directory must not hardcode repo-relative imports
  into `extensions/**`.
- When a helper needs a bundled plugin public/test surface, go through
  `src/test-utils/bundled-plugin-public-surface.ts`.
- Prefer `loadBundledPluginTestApiSync(...)` for eager access to exported test
  helpers.
- Prefer `resolveRelativeBundledPluginPublicModuleId(...)` when a test needs a
  module id for dynamic import or mocking.
- If `vi.mock(...)` hoisting would evaluate the module id too early, use
  `vi.doMock(...)` with the resolved module id instead of falling back to a
  hardcoded path.

## Intent

- Keep shared test helpers aligned with the same public/plugin boundary that
  production code uses.
- Avoid drift where core test helpers start reaching into bundled plugin private
  files by path because it is convenient in one test.
