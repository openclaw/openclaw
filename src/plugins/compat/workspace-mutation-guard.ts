import type { PluginCompatRecord } from "./types.js";

export const WORKSPACE_MUTATION_GUARD_COMPAT_RECORD = {
  code: "workspace-mutation-guard-callback",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-02",
  deprecated: "2026-10-02",
  warningStarts: "2026-10-02",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await database preparation before ensureAgentWorkspace and use SQL-free guard.assertHost for live authority. Internal recovery predicates run on the worker transaction connection.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#workspace-mutation-guards",
  surfaces: ["api.runtime.agent.ensureAgentWorkspace.beforePersistentApply"],
  diagnostics: [
    "@deprecated JSDoc and one DEP_WORKSPACE_MUTATION_GUARD warning per process",
    "Actionable beforePersistentApply error for refused synchronous OpenClaw shared-state access",
  ],
  tests: [
    "src/plugins/runtime/runtime-agent.workspace.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "The released callback still guards each persistent apply, including worker commit admission. Only behavior delta, subject to maintainer veto: reentrant synchronous shared-state DB access in beforePersistentApply is refused with async/typed migration guidance. Removal requires the next Plugin SDK major.",
} as const satisfies PluginCompatRecord;
