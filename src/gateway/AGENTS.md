# Gateway Hot Paths

Gateway server tests and startup paths should not materialize bundled plugin
runtime when they only need plugin-owned static descriptors.

## Guardrails

- For plugin-owned Gateway behavior such as auth-bypass paths, prefer a
  lightweight public artifact resolver before falling back to the full channel
  plugin.
- Keep the full plugin contract and the lightweight artifact backed by the same
  plugin-owned helper so behavior does not diverge.
- Do not load broad bundled channel registries from Gateway HTTP/server code
  just to answer static questions.
- If adding a new plugin-owned Gateway descriptor, add the core resolver,
  plugin artifact, and mirrored full-plugin export in the same change.
- In Gateway server tests, reuse suite-level servers, authenticated contexts,
  and clients when the behavior under test does not require a fresh
  connect/auth handshake. Reset runtime state explicitly instead of restarting
  the whole server per case.
- Keep schedulers, pollers, and background loops disabled in manual-RPC tests
  unless the test is specifically proving automatic scheduling or lifecycle
  behavior.
- Keep Gateway error codes, reasons, and canonical English messages stable.
  Localizable errors must use an explicitly reviewed descriptor from
  `@openclaw/gateway-protocol`; do not derive catalog keys from arbitrary error
  text or translate inside Gateway business logic.
- When adding a descriptor, update the producer, protocol allowlist, rendering
  owner catalog, discriminator-mismatch tests, canonical-English fallback, and
  confirm the rendering catalog source has a `localization/surfaces.json`
  disposition in the same bounded owner slice.

## Verification

- Benchmark the affected Gateway test file before/after with
  `pnpm test <file>`.
- Run `pnpm build` when changing Gateway lazy-loading or bundled plugin
  artifacts.
