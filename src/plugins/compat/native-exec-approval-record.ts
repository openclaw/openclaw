import type { PluginCompatRecord } from "./types.js";

export const NATIVE_EXEC_APPROVAL_COMPAT_RECORD = {
  code: "native-approval-commit-guard",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-09-04",
  deprecated: "2026-10-09",
  warningStarts: "2026-10-09",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Use host-bound api.runtime.gateway.request approval methods. Released opaque approval commit guards run at the worker precommit boundary; they cannot read uncommitted transaction state. Final effect-time authority checks remain synchronous and current.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#use-worker-owned-approval-requests",
  surfaces: ["GatewayRequestHandlerOptions.sessionMutationCommitGuard for approval methods"],
  diagnostics: ["Shared per-plugin capability-family warning on legacy callback use"],
  tests: [
    "src/plugin-sdk/exec-approval-compat.test.ts",
    "src/gateway/server-plugin-in-process-dispatch.commit-guards.test.ts",
  ],
  releaseNote:
    "Bundled approval requests, including reads that expire rows, execute in workers; released opaque commit guards use the same worker precommit boundary.",
} as const satisfies PluginCompatRecord;
