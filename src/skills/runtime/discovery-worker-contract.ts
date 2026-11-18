import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import type { FsSafeErrorCode, FsSafeErrorDetails } from "@openclaw/fs-safe/errors";
import type { SandboxFsPreparation } from "../../agents/sandbox/fs-bridge.types.js";
import type {
  resolveSandboxFsPreparation,
  resolveSandboxFsPathWithMounts,
} from "../../agents/sandbox/fs-paths.js";
import type {
  SandboxMountPlan,
  SandboxMountPlanInput,
} from "../../agents/sandbox/mount-plan.prepare.js";
import type { SandboxStateOwnerPath } from "../../agents/sandbox/state-owner-path.js";
import type { NativeWorkerFailure } from "../../infra/worker-native-error.js";
import type { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import type { WorkspaceSkillStatusFacts } from "../discovery/status.types.js";
import type {
  SkillLibraryFilesystemInput,
  SkillLibraryFilesystemOutput,
} from "../library/filesystem.contract.js";
import type { PluginSkillContribution } from "../loading/plugin-skills.js";
import type { Skill, SkillResourceRootIdentity } from "../loading/skill-contract.js";
import type { SkillSnapshotProjectionInput } from "../loading/skill-snapshot-projection.js";
import type { WorkspaceSkillSourcePlanOptions } from "../loading/workspace-skill-sources.js";
import type {
  WorkspaceSkillSourcePlan,
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSources,
} from "../loading/workspace-skill-sources.types.js";
import type {
  SkillsSyncFilesystemOperation,
  SkillsSyncFilesystemPrepared,
} from "../loading/workspace-skill-sync-files.js";
import type { SkillSnapshot } from "../types.js";

export function captureSkillsDiscoveryEnvironment() {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_BUNDLED_SKILLS_DIR: process.env.OPENCLAW_BUNDLED_SKILLS_DIR,
    OPENCLAW_BUNDLED_PLUGINS_DIR: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
    PREFIX: process.env.PREFIX,
    ANDROID_DATA: process.env.ANDROID_DATA,
  };
}

export type SkillsDiscoveryEnvironment = ReturnType<typeof captureSkillsDiscoveryEnvironment>;

export type SkillsSourcePlanInput = {
  workspaceDir: string;
  environment: SkillsDiscoveryEnvironment;
  options?: Omit<
    WorkspaceSkillSourcePlanOptions,
    "pluginMetadataSnapshot" | "pluginSkillRoots" | "agentSkillsDirs"
  >;
  pluginContributions?: PluginSkillContribution[];
  agentSkillsDirs?: string[];
  acpRuntimeAvailable: boolean;
};

export type SkillsDiscoverySourceSelection =
  | {
      kind: "selected";
      request: WorkspaceSkillSourceRequest;
      plan?: { input: SkillsSourcePlanInput; scope?: "gateway" };
    }
  | {
      kind: "planned";
      request: Omit<WorkspaceSkillSourceRequest, "sourcePlan">;
      plan: { input: SkillsSourcePlanInput };
    };

export type SkillsDiscoveryInput =
  | {
      kind: "companion";
      nativeMode: FsSafeNativeMode;
      directoryPath: string;
      identity: SkillResourceRootIdentity;
      relativePath: string;
      maxBytes: number;
    }
  | {
      kind: "sandbox-projection";
      nativeMode: FsSafeNativeMode;
      input: Parameters<typeof resolveSandboxFsPreparation>[0];
    }
  | {
      kind: "sandbox-path";
      nativeMode: FsSafeNativeMode;
      input: Parameters<typeof resolveSandboxFsPathWithMounts>[0];
    }
  | (({ kind: "sandbox-mounts" } | { kind: "sandbox-mount-sources" }) & {
      stateOwnerPath?: SandboxStateOwnerPath;
      input: SandboxMountPlanInput;
      nativeMode: FsSafeNativeMode;
      authority?: SharedArrayBuffer;
    })
  | { kind: "library"; input: SkillLibraryFilesystemInput; nativeMode: FsSafeNativeMode }
  | {
      kind: "sync-filesystem";
      stateOwnerPath?: SandboxStateOwnerPath;
      nativeMode: FsSafeNativeMode;
      operation: SkillsSyncFilesystemOperation;
      authority?: SharedArrayBuffer;
    }
  | { kind: "plan"; input: SkillsSourcePlanInput }
  | {
      kind: "scan";
      nativeMode: FsSafeNativeMode;
      requests: Array<{
        key: string;
        environment: SkillsDiscoveryEnvironment;
        selection: SkillsDiscoverySourceSelection;
      }>;
      path: string | undefined;
    }
  | {
      kind: "project";
      nativeMode: FsSafeNativeMode;
      input: SkillSnapshotProjectionInput;
      environment: SkillsDiscoveryEnvironment;
    }
  | {
      kind: "status";
      input: Parameters<typeof readWorkspaceSkillStatusFacts>[0];
      environment: SkillsDiscoveryEnvironment;
    };

export type SkillsDiscoveryResult = {
  key: string;
  sources: WorkspaceSkillSources;
  fingerprint: string;
  watchDirectories: string[];
  plan?: WorkspaceSkillSourcePlan;
};

export type SkillsDiscoveryOutput =
  | { kind: "companion"; buffer: Uint8Array }
  | { kind: "sandbox-projection"; preparation: SandboxFsPreparation }
  | { kind: "sandbox-path"; path: ReturnType<typeof resolveSandboxFsPathWithMounts> }
  | { kind: "sandbox-mounts"; plan: SandboxMountPlan }
  | { kind: "sandbox-mount-sources"; created: boolean }
  | { kind: "sandbox-mounts-error"; error: NativeWorkerFailure }
  | { kind: "library"; result: SkillLibraryFilesystemOutput }
  | { kind: "sync-filesystem"; prepared: SkillsSyncFilesystemPrepared | undefined }
  | {
      kind: "sync-filesystem-error";
      error: NativeWorkerFailure;
      code?: FsSafeErrorCode;
      details?: FsSafeErrorDetails;
    }
  | { kind: "plan"; plan: WorkspaceSkillSourcePlan }
  | { kind: "scan"; results: SkillsDiscoveryResult[] }
  | {
      kind: "project";
      snapshot: Omit<SkillSnapshot, "resolvedSkills" | "discoverySkills">;
      resolvedIndices: number[];
      discoveryIndices: number[];
      resourceRoots: Array<Skill["resourceRootIdentity"]>;
    }
  | { kind: "status"; facts: WorkspaceSkillStatusFacts };
