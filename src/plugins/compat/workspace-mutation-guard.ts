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
    "Warning explains before-dispatch timing and deprecated but allowed synchronous OpenClaw DB access",
  ],
  tests: ["src/plugins/runtime/runtime-agent.test.ts", "src/plugins/compat/registry.test.ts"],
  releaseNote:
    "Released callbacks and their synchronous OpenClaw DB access remain supported. The legacy check runs once before worker dispatch, outside admission grants; use the typed guard for live revocation at commit. Removal requires the next Plugin SDK major.",
} as const satisfies PluginCompatRecord;
