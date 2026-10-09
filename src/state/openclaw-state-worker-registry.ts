import type { AcpSessionWriteOperations } from "../acp/runtime/session-meta-write.worker-contract.js";
import type { AuthProfileWorkerOperations } from "../agents/auth-profiles/store.worker-contract.js";
import type { NativeHookRelayStoreWorkerOperations } from "../agents/harness/native-hook-relay-store.worker-contract.js";
import type { McpOAuthWorkerOperations } from "../agents/mcp-oauth-store.worker.js";
import type { PluginModelCatalogCredentialReadWorkerOperations } from "../agents/plugin-model-catalog-read.worker.js";
import type { WorktreeWorkerOperations } from "../agents/worktrees/dispatch.worker.js";
import type { AuditWorkerOperations } from "../audit/audit-event-writer.worker.js";
import type { ChannelIngressWorkerOperations } from "../channels/message/ingress-queue.worker-contract.js";
import type { ClawProvenanceWriteOperations } from "../claws/provenance-write.worker-contract.js";
import type { DoctorWorkerOperations } from "../commands/doctor-state.worker.js";
import type { ConfigSnapshotWorkerOperations } from "../config/config-journal-snapshot.worker-contract.js";
import type { ManagedImageRecordWorkerOperations } from "../gateway/managed-image-record-store.kernel.js";
import type { MentionWorkerOperations } from "../gateway/mention-inbox.worker-contract.js";
import type { OperatorApprovalWorkerOperations } from "../gateway/operator-approval-store.worker-contract.js";
import type { WorkerInferenceStoreOperations } from "../gateway/worker-environments/inference-store.worker-contract.js";
import type { localWorkspaceOperations } from "../gateway/worker-environments/local-workspace-store.worker.js";
import type { WorkerPlacementDispatchStoreOperations } from "../gateway/worker-environments/placement-dispatch-store.worker-contract.js";
import type { PlacementSessionToolWorkerOperations } from "../gateway/worker-environments/placement-session-tool-operations.worker-contract.js";
import type { PlacementTurnClaimWorkerOperations } from "../gateway/worker-environments/placement-turn-claims.worker-contract.js";
import type { WorkspaceJournalWorkerOperations } from "../gateway/worker-environments/placement-workspace-journal.worker-contract.js";
import type { PreparedPoolPresenceWorkerOperations } from "../gateway/worker-environments/prepared-pool-presence.worker.js";
import type { WorkerEnvironmentWorkerOperations } from "../gateway/worker-environments/store-worker-contract.js";
import type { WorkerTranscriptCommitOperations } from "../gateway/worker-environments/transcript-commit-store.worker-contract.js";
import type { DeliveryQueueWorkerOperations } from "../infra/delivery-queue.worker-contract.js";
import type { DevicePairingWorkerOperations } from "../infra/device-pairing-worker-contract.js";
import type { ExecAuthorizationWorkerOperations } from "../infra/exec-approvals-authorization.worker-contract.js";
import type { gatewayBootOperations } from "../infra/gateway-boot-lifecycle.worker.js";
import type { CurrentConversationBindingWorkerOperations } from "../infra/outbound/current-conversation-bindings.worker.js";
import type { PromotionWorkerOperations } from "../infra/promotions-feed.worker.js";
import type { ApnsRegistrationWorkerOperations } from "../infra/push-apns-store.worker-contract.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { RestartSentinelWorkerOperations } from "../infra/restart-sentinel.worker-contract.js";
import type { SessionDeliveryWorkerOperations } from "../infra/session-delivery-queue.worker.js";
import type { DiagnosticWorkerOperations } from "../infra/sqlite-audit-record.worker-contract.js";
import type { LegacyMcpOAuthWorkerOperations } from "../infra/state-migrations.mcp-oauth.worker.js";
import type { TelemetryWorkerOperations } from "../infra/telemetry-store.worker.js";
import type { GeneratedHtmlProvenanceOperations } from "../media/generated-html-provenance.worker-contract.js";
import type { ModelCatalogWorkerOperations } from "../model-catalog/remote-store.worker.js";
import type { NodeWorkerJournalWorkerOperations } from "../node-host/node-worker-journal.worker-contract.js";
import type { ChannelPairingWorkerOperations } from "../pairing/pairing-store.worker-contract.js";
import type { PluginBlobWorkerOperations } from "../plugin-state/plugin-blob-store.worker.js";
import type { PluginRuntimeWorkerOperations } from "../plugins/state.worker-contract.js";
import type { ProjectRegistryWorkerOperations } from "../projects/project-registry.worker-contract.js";
import type { SkillLibraryWorkerOperations } from "../skills/library/store.worker-contract.js";
import type { SkillUploadWorkerOperations } from "../skills/lifecycle/upload-store.worker-contract.js";
import type { SkillWorkshopWorkerOperations } from "../skills/workshop/changes.worker-contract.js";
import type { TranscriptWriteOperations } from "../transcripts/store-write.worker-contract.js";
import type { agentRecoveryOperations } from "./agent-deletion-recovery.worker.js";
import type { agentDeletionOperations } from "./agent-deletion.worker.js";
import type { OnboardingRecommendationWriteOperations } from "./onboarding-recommendations.kernel.js";
import type { AgentDatabaseRegistryWorkerOperations } from "./openclaw-agent-db-contract.js";
import type { RepositoryWorkspaceWorkerOperations } from "./session-repository-workspaces.worker-contract.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export type RegisteredStateWorkerOperations = WorkerOperations<typeof gatewayBootOperations> &
  WorkerOperations<typeof agentDeletionOperations> &
  WorkerOperations<typeof agentRecoveryOperations> &
  WorkerOperations<typeof localWorkspaceOperations> &
  ClawProvenanceWriteOperations &
  GeneratedHtmlProvenanceOperations &
  MentionWorkerOperations &
  ConfigSnapshotWorkerOperations &
  DiagnosticWorkerOperations &
  RestartSentinelWorkerOperations &
  WebPushWorkerOperations &
  PreparedPoolPresenceWorkerOperations &
  ProjectRegistryWorkerOperations &
  ApnsRegistrationWorkerOperations &
  WorktreeWorkerOperations &
  OperatorApprovalWorkerOperations &
  ExecAuthorizationWorkerOperations &
  DeliveryQueueWorkerOperations &
  SessionDeliveryWorkerOperations &
  CurrentConversationBindingWorkerOperations &
  DevicePairingWorkerOperations &
  ChannelPairingWorkerOperations &
  McpOAuthWorkerOperations &
  LegacyMcpOAuthWorkerOperations &
  NativeHookRelayStoreWorkerOperations &
  AuditWorkerOperations &
  PromotionWorkerOperations &
  TelemetryWorkerOperations &
  DoctorWorkerOperations &
  ModelCatalogWorkerOperations &
  ManagedImageRecordWorkerOperations &
  PluginBlobWorkerOperations &
  OnboardingRecommendationWriteOperations &
  NodeWorkerJournalWorkerOperations &
  ChannelIngressWorkerOperations &
  AcpSessionWriteOperations &
  SkillUploadWorkerOperations &
  SkillLibraryWorkerOperations &
  SkillWorkshopWorkerOperations &
  TranscriptWriteOperations &
  AuthProfileWorkerOperations &
  AgentDatabaseRegistryWorkerOperations &
  PluginModelCatalogCredentialReadWorkerOperations &
  PluginRuntimeWorkerOperations &
  WorkerInferenceStoreOperations &
  WorkerPlacementDispatchStoreOperations &
  PlacementSessionToolWorkerOperations &
  PlacementTurnClaimWorkerOperations &
  WorkspaceJournalWorkerOperations &
  WorkerEnvironmentWorkerOperations &
  WorkerTranscriptCommitOperations &
  RepositoryWorkspaceWorkerOperations &
  UserProfileWorkerOperations;

export const stateWorkerRegistry = createWorkerOperationRegistry<
  RegisteredStateWorkerOperations,
  WorkerWriteOperationContext
>({
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
  userProfiles: () => import("./user-profiles.worker.js").then((m) => m.userProfileOperations),
  agentDatabaseRegistry: () =>
    import("./openclaw-agent-db-registry.worker.js").then((m) => m.agentDatabaseRegistryOperations),
  authProfiles: () =>
    import("../agents/auth-profiles/store.worker.js").then((m) => m.authProfileOperations),
  pluginModelCatalogCredentials: () =>
    import("../agents/plugin-model-catalog-read.worker.js").then(
      (m) => m.pluginModelCatalogCredentialReadOperations,
    ),
  plugins: () => import("../plugins/state.worker.js").then((m) => m.pluginRuntimeOperations),
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
    import("../gateway/worker-environments/placement-dispatch-store.worker.js").then(
      (m) => m.workerPlacementOperations,
    ),
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
});
