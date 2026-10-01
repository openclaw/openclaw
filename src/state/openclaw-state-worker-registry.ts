import type { AcpSessionWriteOperations } from "../acp/runtime/session-meta-write.worker-contract.js";
import type { AuthProfileWorkerOperations } from "../agents/auth-profiles/store.worker-contract.js";
import type { NativeHookRelayStoreWorkerOperations } from "../agents/harness/native-hook-relay-store.worker-contract.js";
import type { McpOAuthWorkerOperations } from "../agents/mcp-oauth-store.worker.js";
import type { WorktreeWorkerOperations } from "../agents/worktrees/dispatch.worker.js";
import type { AuditWorkerOperations } from "../audit/audit-event-writer.worker.js";
import type { ChannelIngressWorkerOperations } from "../channels/message/ingress-queue.worker-contract.js";
import type { DoctorWorkerOperations } from "../commands/doctor-state.worker.js";
import type { FleetRegistryWriteOperations } from "../fleet/registry.worker-contract.js";
import type { ManagedImageRecordWorkerOperations } from "../gateway/managed-image-record-store.kernel.js";
import type { OperatorApprovalWorkerOperations } from "../gateway/operator-approval-store.worker-contract.js";
import type { DeliveryQueueWorkerOperations } from "../infra/delivery-queue.worker-contract.js";
import type { DevicePairingWorkerOperations } from "../infra/device-pairing-worker-contract.js";
import type { ExecAuthorizationWorkerOperations } from "../infra/exec-approvals-authorization.worker-contract.js";
import type { CurrentConversationBindingWorkerOperations } from "../infra/outbound/current-conversation-bindings.worker.js";
import type { PromotionWorkerOperations } from "../infra/promotions-feed.worker.js";
import type { ApnsRegistrationWorkerOperations } from "../infra/push-apns-store.worker-contract.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { SessionDeliveryWorkerOperations } from "../infra/session-delivery-queue.worker.js";
import type { LegacyMcpOAuthWorkerOperations } from "../infra/state-migrations.mcp-oauth.worker.js";
import type { TelemetryWorkerOperations } from "../infra/telemetry-store.worker.js";
import type { ModelCatalogWorkerOperations } from "../model-catalog/remote-store.worker.js";
import type { NodeWorkerJournalWorkerOperations } from "../node-host/node-worker-journal.worker-contract.js";
import type { PluginBlobWorkerOperations } from "../plugin-state/plugin-blob-store.worker.js";
import type { PluginRuntimeWorkerOperations } from "../plugins/state.worker-contract.js";
import type { ProjectRegistryWorkerOperations } from "../projects/project-registry.worker-contract.js";
import type { SkillUploadWorkerOperations } from "../skills/lifecycle/upload-store.worker-contract.js";
import type {
  SkillWorkshopWorkerOperations,
  SkillCuratorOperations,
} from "../skills/workshop/store.worker-contract.js";
import type { TranscriptWriteOperations } from "../transcripts/store-write.worker-contract.js";
import type { OnboardingRecommendationWriteOperations } from "./onboarding-recommendations.kernel.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export type RegisteredStateWorkerOperations = WebPushWorkerOperations &
  ProjectRegistryWorkerOperations &
  ApnsRegistrationWorkerOperations &
  WorktreeWorkerOperations &
  FleetRegistryWriteOperations &
  OperatorApprovalWorkerOperations &
  ExecAuthorizationWorkerOperations &
  DeliveryQueueWorkerOperations &
  SessionDeliveryWorkerOperations &
  CurrentConversationBindingWorkerOperations &
  DevicePairingWorkerOperations &
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
  SkillWorkshopWorkerOperations &
  SkillCuratorOperations &
  TranscriptWriteOperations &
  AuthProfileWorkerOperations &
  PluginRuntimeWorkerOperations &
  UserProfileWorkerOperations;

export const stateWorkerRegistry = createWorkerOperationRegistry<RegisteredStateWorkerOperations>({
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
  authProfiles: () =>
    import("../agents/auth-profiles/store.worker.js").then((m) => m.authProfileOperations),
  plugins: () => import("../plugins/state.worker.js").then((m) => m.pluginRuntimeOperations),
  acp: () =>
    import("../acp/runtime/session-meta-write.worker.js").then((m) => m.acpSessionOperations),
  skillUploads: () =>
    import("../skills/lifecycle/upload-store.worker.js").then((m) => m.skillUploadOperations),
  workshop: () =>
    import("../skills/workshop/store.worker.js").then((m) => m.skillWorkshopOperations),
  skills: () => import("../skills/workshop/store.worker.js").then((m) => m.skillCuratorOperations),
  transcripts: () =>
    import("../transcripts/store-worker-write.js").then((m) => m.transcriptWriteOperations),
  webPush: () => import("../infra/push-web-store.worker.js").then((m) => m.webPushOperations),
  apns: () => import("../infra/push-apns-store.worker.js").then((m) => m.apnsOperations),
  worktrees: () =>
    import("../agents/worktrees/dispatch.worker.js").then((m) => m.worktreeOperations),
  fleet: () => import("../fleet/registry.worker.js").then((m) => m.fleetOperations),
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
});
