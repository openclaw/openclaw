# Shared Test Helper Boundary

## Bundled Plugin Imports

- Bundled plugin public surfaces: go through
  `src/test-utils/bundled-plugin-public-surface.ts`; the helper boundary test
  rejects `extensions/**` imports.
- Prefer `resolveRelativeBundledPluginPublicModuleId(...)` or
  `resolveBundledPluginPublicModulePath(...)` when a helper needs a module id
  or filesystem path for dynamic import, mocking, or loading a plugin entrypoint
  such as `index.js`.
- If `vi.hoisted(...)` is involved, do not call imported helper functions from
  inside the hoisted callback. Resolve the module id outside the callback or
  switch to `vi.doMock(...)`.
- Plugin-local deep mocks and private `src/**` knowledge live in the owning
  bundled plugin package.
