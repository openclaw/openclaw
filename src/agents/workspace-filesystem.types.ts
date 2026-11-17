import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import type { FsSafeErrorCode } from "../infra/fs-safe.js";
import type { NativeWorkerFailure } from "../infra/worker-native-error.js";
import type { SandboxStateOwnerPath } from "./sandbox/state-owner-path.js";
import type { WorkspaceFilesystemEvidence } from "./workspace-state-guard.js";

export type WorkspaceFilesystemMutation =
  | { kind: "mkdir"; dir: string }
  | {
      kind: "publish" | "seed" | "purpose";
      dir: string;
      name: string;
      content: string | Uint8Array;
    }
  | { kind: "remove"; dir: string; name: string }
  | { kind: "copy"; dir: string; seed?: string }
  | { kind: "git-init"; dir: string };

export type LegacyWorkspaceResetPlan = {
  candidates: {
    root: WorkspaceFilesystemEvidence | { workspaceDir: string; error: string };
    sourcePath: string;
    requireAttestationHeader: boolean;
  }[];
};

export type LegacyWorkspaceResetResult = { removedPaths: string[]; warnings: string[] };

export type WorkspaceLegacyResetOperation = {
  kind: "legacy-reset";
  plan: LegacyWorkspaceResetPlan;
  dryRun?: boolean;
};

export type WorkspaceFilesystemOperation =
  | WorkspaceFilesystemMutation
  | WorkspaceLegacyResetOperation;

export type WorkspaceFilesystemCommand = {
  type: "workspace";
  nativeMode: FsSafeNativeMode;
  operation: WorkspaceFilesystemOperation;
  filesystem: WorkspaceFilesystemEvidence[];
  stateOwnerPath?: SandboxStateOwnerPath;
  decision: SharedArrayBuffer;
};

export type WorkspaceFilesystemReply =
  | { type: "workspace"; created: boolean; filesystem: WorkspaceFilesystemEvidence[] }
  | {
      type: "workspace-legacy-reset";
      removedPaths: string[];
      warnings: {
        sourcePath: string;
        action: "inspect" | "remove";
        error: string;
        authorityRefused?: boolean;
      }[];
    }
  | {
      type: "workspace-failed";
      error: NativeWorkerFailure;
      fsCode?: FsSafeErrorCode;
      details?: Readonly<Record<string, unknown>>;
      alias?: { aliasPath: string; storedWorkspacePath: string; currentWorkspacePath: string };
    };

export type WorkspaceFileSourceIdentity = readonly [
  canonicalPath: string,
  stat: FileIdentityStat | undefined,
  workspaceRelativePath?: string,
];

export type WorkspaceGuardedReadResult =
  | { ok: true; content: string; sourceIdentity: WorkspaceFileSourceIdentity }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

export type WorkspaceFilesystemReadCommand = {
  type: "workspace-read";
  nativeMode: FsSafeNativeMode;
  input: {
    filePath: string;
    workspaceDir: string;
    /** Identity-scoped files must not alias another profile through parent symlinks. */
    rejectAliases?: boolean;
  };
};

export type WorkspaceFilesystemReadReply = {
  type: "workspace-read";
  result:
    | Extract<WorkspaceGuardedReadResult, { ok: true }>
    | {
        ok: false;
        reason: "path" | "validation" | "io";
        error?: NativeWorkerFailure;
        fsCode?: FsSafeErrorCode;
        details?: Readonly<Record<string, unknown>>;
      };
};
