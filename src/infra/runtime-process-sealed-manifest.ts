import type {
  createRuntimeProcessEntrypoints,
  runtimeProcessDeployManifest,
  runtimeProcessHelperManifest,
} from "./runtime-process-manifest.js";

// Each sealed bootstrap selects only the sibling entries it owns.
export const runtimeProcessSealedManifest = {
  managedHandoff: {
    ownerSource: "src/infra/update-managed-service-handoff-sealed.ts",
    entries: [["postgresBridge", "managedHandoffPostgresBridge"]],
  },
  worker: {
    ownerSource: "src/worker/worker-deploy-runtime.ts",
    entries: [
      ["clientCredentials", "client-credential.worker"],
      ["codeModeNode", "code-mode-node.worker"],
      ["stateRead", "openclaw-state-read.worker"],
      ["workerNativeLifecycle", "worker-native-lifecycle.worker"],
      ["fileToolPlanning", "file-tool-planning.worker"],
      ["fileToolRead", "file-tool-read.worker"],
      ["gatewayStateOwnerHeartbeat", "gateway-state-owner-heartbeat.worker"],
      ["githubExec", "github-exec-launcher"],
      ["imageProcessor", "image-processor.worker"],
      ["serviceChildRelay", "service-child-relay"],
      ["sqliteSourceRevision", "sqlite-source-revision.worker"],
      ["sqliteStore", "sqlite-store.worker"],
      ["sharedStateStore", "sqlite-store.worker"],
    ],
  },
  serviceChildRelay: {
    ownerSource: "src/process/supervisor/service-child-relay.ts",
    entries: [["serviceChildGroupAnchor", "service-child-group-anchor"]],
  },
} as const satisfies Record<
  string,
  {
    ownerSource: string;
    entries: readonly (readonly [
      keyof ReturnType<typeof createRuntimeProcessEntrypoints>,
      (
        | keyof typeof runtimeProcessDeployManifest
        | keyof typeof runtimeProcessHelperManifest
        | keyof ReturnType<typeof createRuntimeProcessEntrypoints>
      ),
    ])[];
  }
>;
