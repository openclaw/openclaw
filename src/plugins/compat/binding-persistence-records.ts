import type { PluginCompatRecord } from "./types.js";

export const BINDING_PERSISTENCE_COMPAT_RECORDS = [
  {
    code: "native-session-binding-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use createNativeSessionBindingLifecycleV2 and resolveNativeSessionBindingWithAuthorityV2 with the worker-backed binding store. Implement AgentHarness.resolveSessionRuntimeOwnershipAsync for preparation. Exact synchronous final-authority checks retain their native adapter until complete publication and the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-plugin-state-and-conversation-bindings",
    surfaces: [
      "createNativeSessionBindingLifecycle",
      "NativeSessionBindingStateStore",
      "resolveNativeSessionBindingWithAuthority",
      "AgentHarness.resolveSessionRuntimeOwnership",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and the shared per-plugin capability-family warning budget",
    ],
    tests: [
      "extensions/codex/harness.test.ts",
      "src/agents/embedded-agent-runner/run/model-setup.ownership.test.ts",
      "src/gateway/session-row-projection.worker-read.test.ts",
    ],
    releaseNote:
      "Native harness binding preparation and ordinary durable settlement use workers. Host-selected initialization, incognito, and mixed legacy deletion transactions retain their explicit native atomic settlement; no schema or update migration is required.",
  },
] as const satisfies readonly PluginCompatRecord[];
