import type { AcpSessionWriteOperations } from "../acp/runtime/session-meta-write.worker-contract.js";
import type { AuthProfileWorkerOperations } from "../agents/auth-profiles/store.worker-contract.js";
import type { WorktreeWorkerOperations } from "../agents/worktrees/dispatch.worker.js";
import type { FleetRegistryWriteOperations } from "../fleet/registry.worker-contract.js";
import type { ApnsRegistrationWorkerOperations } from "../infra/push-apns-store.worker-contract.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { PluginRuntimeWorkerOperations } from "../plugins/state.worker-contract.js";
import type { SkillUploadWorkerOperations } from "../skills/lifecycle/upload-store.worker-contract.js";
import type {
  SkillWorkshopWorkerOperations,
  SkillCuratorOperations,
} from "../skills/workshop/store.worker-contract.js";
import type { TranscriptWriteOperations } from "../transcripts/store-write.worker-contract.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export type RegisteredStateWorkerOperations = WebPushWorkerOperations &
  ApnsRegistrationWorkerOperations &
  WorktreeWorkerOperations &
  FleetRegistryWriteOperations &
  AcpSessionWriteOperations &
  SkillUploadWorkerOperations &
  SkillWorkshopWorkerOperations &
  SkillCuratorOperations &
  TranscriptWriteOperations &
  AuthProfileWorkerOperations &
  PluginRuntimeWorkerOperations &
  UserProfileWorkerOperations;

export const stateWorkerRegistry = createWorkerOperationRegistry<RegisteredStateWorkerOperations>({
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
});
