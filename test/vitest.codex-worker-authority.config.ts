import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";

// Run: node scripts/run-vitest.mjs run --config test/vitest.codex-worker-authority.config.ts
// The production shared-state broker owns SQLite workers from the application main thread.
export default createScopedVitestConfig(["test/codex-worker-authority.proof.ts"], {
  name: "codex-worker-authority-proof",
  pool: "forks",
  isolate: true,
});
