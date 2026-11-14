import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import type { CloneFileMetadata, TreeCloneBackend } from "@openclaw/fs-safe/copy";
import type { FsSafeErrorCode } from "@openclaw/fs-safe/errors";
import type { DarwinAclInspection } from "@openclaw/fs-safe/permissions";
import type {
  WorkspaceFilesystemCommand,
  WorkspaceFilesystemReadCommand,
  WorkspaceFilesystemReadReply,
  WorkspaceFilesystemReply,
} from "../agents/workspace-filesystem.types.js";
import type { WorktreeWorkerAuthority } from "../agents/worktrees/types.js";
import type { ScratchTreeResult } from "./scratch-cleanup-tree.js";
export type { CloneFileMetadata } from "@openclaw/fs-safe/copy";

export type FsSafeCopyRead =
  | { type: "probe"; parent: string }
  | { type: "acl"; path: string }
  | { type: "metadata"; paths: string[] };

export type PluginCaptureReclaimCandidate = {
  directory: string;
  identity: { dev: number; ino: number; uid: number };
  kind: "managed" | "legacy";
};

export type FsSafeCopyWrite =
  | { type: "reclaim-plugin-captures"; candidates: readonly PluginCaptureReclaimCandidate[] }
  | { type: "create"; destination: string }
  | { type: "remove"; destination: string }
  | { type: "copy"; source: string; destination: string };

export type FsSafeStoreRemove = {
  type: "remove-store-file";
  rootDir: string;
  relativePath: string;
  nativeMode: FsSafeNativeMode;
};

export type FsSafeFilesystemCommand =
  | WorkspaceFilesystemCommand
  | WorkspaceFilesystemReadCommand
  | FsSafeStoreRemove;
export type FsSafeStoreReply = Extract<FsSafeCopyReply, { type: "written" | "failed" }>;
export type FsSafeFilesystemReply =
  | WorkspaceFilesystemReply
  | WorkspaceFilesystemReadReply
  | FsSafeStoreReply;

export type FsSafeProvisionCopy = FsSafeProvisionCopyInput & { decision: SharedArrayBuffer };

export type FsSafeProvisionCopyInput = Pick<
  WorktreeWorkerAuthority,
  "workspaceEvidence" | "stateOwnerPath"
> & {
  source: string;
  destination: string;
  paths: readonly string[];
} & ({ type: "provision" } | { type: "refs-copy"; nativeMode: FsSafeNativeMode });

export type ProvisionCopyDetails = {
  copier: "linux-batched" | "portable";
  fallbackReason?:
    | "platform"
    | "procfs-unavailable"
    | "proc-descriptors-unavailable"
    | "gnu-cp-unavailable"
    | "helper-unavailable";
  batchCount: number;
  sourceBytes: number;
  spawnCount: number;
  spawnMs: number;
  childMs: number;
  authorityChecks: number;
  authorityMs: number;
};

export type FsSafeCopyReply =
  | ScratchTreeResult
  | { type: "captures-reclaimed"; failures: number; firstFailure?: string }
  | WorkspaceFilesystemReply
  | WorkspaceFilesystemReadReply
  | { type: "probe"; backend: TreeCloneBackend | undefined; nativeMode: FsSafeNativeMode }
  | { type: "metadata"; entries: (CloneFileMetadata | undefined)[] }
  | { type: "acl"; acl: DarwinAclInspection }
  | { type: "written"; workspaceEvidence?: WorktreeWorkerAuthority["workspaceEvidence"] }
  | {
      type: "provisioned";
      paths: string[];
      copyDetails?: ProvisionCopyDetails;
      workspaceEvidence?: WorktreeWorkerAuthority["workspaceEvidence"];
    }
  | {
      type: "failed";
      message: string;
      code?: string;
      fsSafeCode?: FsSafeErrorCode;
      copyDetails?: ProvisionCopyDetails;
    };
