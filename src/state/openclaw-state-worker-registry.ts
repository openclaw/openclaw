import type {
  WorkerOperationsFromLoaders,
  WorkerWriteOperationContext,
} from "./worker-operation-registry.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

const loaders = {
  clawAdoption: () => import("./claw-adoption.worker.js").then((m) => m.clawAdoptionOperations),
  machineState: () =>
    import("./config-machine-state.worker.js").then((m) => m.machineStateOperations),
  agentDeletion: () => import("./agent-deletion.worker.js").then((m) => m.agentDeletionOperations),
  agentRecovery: () =>
    import("./agent-deletion-recovery.worker.js").then((m) => m.agentRecoveryOperations),
  gatewayBoot: () =>
    import("../infra/gateway-boot-lifecycle.worker.js").then((m) => m.gatewayBootOperations),
  localWorkspace: () =>
    import("../gateway/worker-environments/local-workspace-store.worker.js").then(
      (m) => m.localWorkspaceOperations,
    ),
  generatedHtmlProvenance: () =>
    import("../media/generated-html-provenance.worker.js").then(
      (m) => m.generatedHtmlProvenanceOperations,
    ),
  mentions: () =>
    import("../gateway/mention-inbox.worker.js").then((m) => m.mentionWorkerOperations),
  config: () =>
    import("../config/config-journal-snapshot.worker.js").then((m) => m.configSnapshotOperations),
  diagnostic: () =>
    import("../infra/sqlite-audit-record.worker.js").then((m) => m.diagnosticOperations),
  restartSentinel: () =>
    import("../infra/restart-sentinel.worker.js").then((m) => m.restartSentinelOperations),
  preparedPoolPresence: () =>
    import("../gateway/worker-environments/prepared-pool-presence.worker.js").then(
      (m) => m.preparedPoolPresenceOperations,
    ),
  clawProvenance: () =>
    import("../claws/provenance-write.worker.js").then((m) => m.clawProvenanceOperations),
  projects: () =>
    import("../projects/project-registry.worker.js").then((m) => m.projectRegistryOperations),
  operatorApprovals: () =>
    import("../gateway/operator-approval-store.operations.js").then(
      (m) => m.operatorApprovalOperations,
    ),
  execApprovals: () =>
    import("../infra/exec-approvals-authorization.worker.js").then(
      (m) => m.execAuthorizationOperations,
    ),
  userGitHubConnections: () =>
    import("./user-github-connections.worker.js").then((m) => m.userGitHubConnectionOperations),
  githubPublications: () =>
    import("./github-publication.worker.js").then((m) => m.publicationOperations),
  userBackground: async () =>
    (await import("./user-background.worker.js")).userBackgroundOperations,
  userProfiles: () => import("./user-profiles.worker.js").then((m) => m.userProfileOperations),
  githubSetup: () =>
    import("../secrets/store/secret-store-github-handoff.worker.js").then(
      (m) => m.githubSetupOperations,
    ),
  agentDatabaseRegistry: () =>
    import("./openclaw-agent-db-registry.worker.js").then((m) => m.agentDatabaseRegistryOperations),
  authProfiles: () =>
    import("../agents/auth-profiles/store.worker.js").then((m) => m.authProfileOperations),
  pluginModelCatalogCredentials: () =>
    import("../agents/plugin-model-catalog-read.worker.js").then(
      (m) => m.pluginModelCatalogCredentialReadOperations,
    ),
  plugins: () => import("../plugins/state.worker.js").then((m) => m.pluginRuntimeOperations),
  acpReplay: () => import("../acp/event-ledger.worker.js").then((m) => m.acpReplayOperations),
  acp: () =>
    import("../acp/runtime/session-meta-write.worker.js").then((m) => m.acpSessionOperations),
  skillLibrary: () =>
    import("../skills/library/store.worker.js").then((m) => m.skillLibraryOperations),
  skillUploads: () =>
    import("../skills/lifecycle/upload-store.worker.js").then((m) => m.skillUploadOperations),
  skills: () =>
    import("../skills/workshop/changes.worker.js").then((m) => m.skillWorkshopOperations),
  transcripts: () =>
    import("../transcripts/store-worker-write.js").then((m) => m.transcriptWriteOperations),
  webPush: () => import("../infra/push-web-store.worker.js").then((m) => m.webPushOperations),
  apns: () => import("../infra/push-apns-store.worker.js").then((m) => m.apnsOperations),
  worktrees: () =>
    import("../agents/worktrees/dispatch.worker.js").then((m) => m.worktreeOperations),
  mcpOAuth: () => import("../agents/mcp-oauth-store.worker.js").then((m) => m.mcpOAuthOperations),
  legacyMcpOAuth: () =>
    import("../infra/state-migrations.mcp-oauth.worker.js").then((m) => m.legacyMcpOAuthOperations),
  nativeHookRelay: () =>
    import("../agents/harness/native-hook-relay-store.worker.js").then(
      (m) => m.nativeHookRelayOperations,
    ),
  audit: () => import("../audit/audit-event-writer.worker.js").then((m) => m.auditOperations),
  promotions: () => import("../infra/promotions-feed.worker.js").then((m) => m.promotionOperations),
  telemetry: () => import("../infra/telemetry-store.worker.js").then((m) => m.telemetryOperations),
  doctor: () => import("../commands/doctor-state.worker.js").then((m) => m.doctorOperations),
  modelCatalog: () =>
    import("../model-catalog/remote-store.worker.js").then((m) => m.modelCatalogOperations),
  managedImages: () =>
    import("../gateway/managed-image-record-store.kernel.js").then(
      (m) => m.managedImageRecordOperations,
    ),
  pluginBlob: () =>
    import("../plugin-state/plugin-blob-store.worker.js").then((m) => m.pluginBlobOperations),
  onboardingRecommendations: () =>
    import("./onboarding-recommendations.kernel.js").then(
      (m) => m.onboardingRecommendationOperations,
    ),
  nodeWorker: () =>
    import("../node-host/node-worker-journal.worker.js").then((m) => m.nodeWorkerJournalOperations),
  channelIngress: () =>
    import("../channels/message/ingress-queue.worker.js").then((m) => m.channelIngressOperations),
  channelPairing: () =>
    import("../pairing/pairing-store.worker.js").then((m) => m.channelPairingOperations),
  devicePairing: () =>
    import("../infra/device-pairing-core.worker.js").then((m) => m.devicePairingOperations),
  node: () => import("../infra/device-pairing-node.worker.js").then((m) => m.nodePairingOperations),
  bootstrap: () =>
    import("../infra/device-bootstrap.worker-kernel.js").then((m) => m.deviceBootstrapOperations),
  deliveryQueue: () =>
    import("../infra/delivery-queue.worker.js").then((m) => m.deliveryQueueOperations),
  sessionDelivery: () =>
    import("../infra/session-delivery-queue.worker.js").then((m) => m.sessionDeliveryOperations),
  conversationBindings: () =>
    import("../infra/outbound/current-conversation-bindings.worker.js").then(
      (m) => m.conversationBindingOperations,
    ),
  workerInference: () =>
    import("../gateway/worker-environments/inference-store.worker.js").then(
      (m) => m.workerInferenceOperations,
    ),
  workerPlacements: () =>
    import("../gateway/worker-environments/placement-lifecycle.worker.js").then((m) => ({
      ...m.placementLifecycleOperations,
      ...m.placementReadOperations,
    })),
  placementTools: () =>
    import("../gateway/worker-environments/placement-session-tool-operations.worker.js").then(
      (m) => m.placementSessionToolOperations,
    ),
  placementTurns: () =>
    import("../gateway/worker-environments/placement-turn-claims.worker.js").then(
      (m) => m.placementTurnClaimOperations,
    ),
  placementJournals: () =>
    import("../gateway/worker-environments/placement-workspace-journal.worker.js").then(
      (m) => m.workspaceJournalOperations,
    ),
  placementTranscript: () =>
    import("../gateway/worker-environments/transcript-commit-store.worker.js").then(
      (m) => m.workerTranscriptCommitOperations,
    ),
  workerEnvironments: () =>
    import("../gateway/worker-environments/store.worker.js").then(
      (m) => m.workerEnvironmentOperations,
    ),
  repositoryWorkspaces: () =>
    import("./session-repository-workspaces.worker.js").then(
      (m) => m.repositoryWorkspaceOperations,
    ),
};

export type RegisteredStateWorkerOperations = WorkerOperationsFromLoaders<typeof loaders>;

export const stateWorkerRegistry = createWorkerOperationRegistry<
  RegisteredStateWorkerOperations,
  WorkerWriteOperationContext
>(loaders);
