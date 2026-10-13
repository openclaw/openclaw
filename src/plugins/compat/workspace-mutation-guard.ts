import type { PluginCompatRecord } from "./types.js";

export const WORKSPACE_MUTATION_GUARD_COMPAT_RECORD = {
  code: "workspace-mutation-guard-callback",
  status: "removed",
  owner: "sdk",
  introduced: "2026-10-02",
  deprecated: "2026-10-02",
  warningStarts: "2026-10-02",
  replacement:
    "Await database preparation before ensureAgentWorkspace and use SQL-free guard.assertHost for live authority. Internal recovery predicates run on the worker transaction connection.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#workspace-mutation-guards",
  surfaces: ["api.runtime.agent.ensureAgentWorkspace.beforePersistentApply"],
  diagnostics: ["plugin compatibility registry and migration guide"],
  tests: ["src/plugins/runtime/runtime-agent.test.ts", "src/plugins/compat/registry.test.ts"],
  releaseNote:
    "Removes beforePersistentApply first deprecated in stable v2026.10.1. Prepare inputs before dispatch and use the typed SQL-free host guard at the effect boundary; worker-owned recovery predicates remain supported.",
} as const satisfies PluginCompatRecord;
