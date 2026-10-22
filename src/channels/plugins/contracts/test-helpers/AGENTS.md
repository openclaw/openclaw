# Channel Contract Helper Boundary

## Bundled Plugin Imports

- Bundled plugin modules: via `src/test-utils/bundled-plugin-public-surface.ts`
  (checked by `scripts/check-test-helper-extension-import-boundary.mts`).
- Prefer `resolveRelativeBundledPluginPublicModuleId(...)` when a test needs a
  module id for dynamic import or mocking.
- If `vi.mock(...)` hoisting would evaluate the module id too early, use
  `vi.doMock(...)` with the resolved module id instead of falling back to a
  hardcoded path.
- Contract fixtures: minimal in-memory plugins; no broad `api.ts`/`runtime-api.ts`/`test-api.ts` barrels.
- If a bundled plugin parser is the contract under test, load the narrow module
  that owns that parser or promote a small public artifact. Avoid pulling a full
  extension barrel just to parse a target id.
