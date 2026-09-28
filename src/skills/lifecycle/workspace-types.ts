/** File-host lifecycle contracts shared by local operations and remote workspace adapters. */
import type { ArchiveLogger } from "../../infra/archive.js";
import type { ClawHubDownloadResult } from "../../infra/clawhub-artifacts.js";
import type {
  ClawHubSkillVerificationResponse,
  ClawHubSkillsShTrustState,
} from "../../infra/clawhub-skills.js";
import type {
  PluginHookSkillArtifact,
  PluginHookSkillChangedEvent,
} from "../../plugins/hook-skill.types.js";
import type { SkillInstallSpec, SkillsInstallPreferences } from "../types.js";
import type { SkillInstallResult } from "./install-types.js";
import type { ClawHubSkillFileState } from "./skill-tree-digest.js";

/** Result shape for installing a skill archive into a workspace skills dir. */
export type SkillArchiveInstallResult =
  | { ok: true; targetDir: string }
  | {
      ok: false;
      error: string;
      failureKind: SkillArchiveInstallFailureKind;
      replacementBlocked?: string;
    };

export type SkillArchiveInstallFailureKind = "invalid-request" | "unavailable";

export type SkillRootInstallFiles = {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  timeoutMs?: number;
  logger?: ArchiveLogger;
  rootMarkers?: readonly string[];
  /** Undefined skips the native update guard; null means the install was absent. */
  expectedClawHubState?: ClawHubSkillFileState | null;
};

export type SkillRootApplyResult =
  | {
      ok: true;
      targetDir: string;
      mode: "install" | "update";
      before?: PluginHookSkillArtifact;
      after?: PluginHookSkillArtifact;
    }
  | Extract<SkillArchiveInstallResult, { ok: false }>;

export type ClawHubSkillDownloadedArtifactLock = {
  kind: ClawHubDownloadResult["artifact"];
  sha256: string;
  integrity: string;
};

export type ClawHubSkillFileLock = {
  path: string;
  sha256: string;
};

export type ClawHubSkillVerificationLock = {
  schema: ClawHubSkillVerificationResponse["schema"];
  ok: boolean;
  decision: ClawHubSkillVerificationResponse["decision"];
  reasons: string[];
  card?: unknown;
  artifact?: unknown;
  provenance?: unknown;
  security?: unknown;
  signature?: unknown;
};

type ClawHubSkillLockEntry = Omit<
  ClawHubSkillOrigin,
  "version" | "slug" | "installedVersion" | "registry"
> & {
  version: string;
  registry?: string;
  verification?: ClawHubSkillVerificationLock;
};

export type ClawHubSkillOrigin = ClawHubSkillRef & {
  version: 1;
  registry: string;
  installedVersion: string;
  installedAt: number;
  sourceUrl?: string;
  artifact?: ClawHubSkillDownloadedArtifactLock;
  skillFile?: ClawHubSkillFileLock;
  fileTreeSha256?: string;
};

export type ClawHubSkillsLockfile = {
  version: 1;
  skills: Record<string, ClawHubSkillLockEntry>;
};

export type ClawHubSkillRef = {
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
};

export type ClawHubSkillVerificationSelector = "installed-version" | "version" | "tag" | "latest";

export type ClawHubSkillVerificationTargetResult =
  | (ClawHubSkillRef & {
      ok: true;
      baseUrl: string;
      version: string | undefined;
      tag: string | undefined;
      resolution: {
        source: "installed" | "registry";
        selector: ClawHubSkillVerificationSelector;
        registry: string;
        skillDir: string | undefined;
        installedVersion: string | undefined;
      };
    })
  | { ok: false; error: string };

export type ClawHubSkillInstallPreflightResult =
  | { ok: true; action: "install" | "reuse"; integrity: string; warning?: string }
  | { ok: false; code: string; error: string };

export type TrackedUpdateTarget =
  | (ClawHubSkillRef & {
      ok: true;
      baseUrl?: string;
      previousVersion: string | null;
    })
  | { ok: false; slug: string; error: string };

export type ClawHubSkillUninstallPlan = ClawHubSkillFileState & {
  workspaceDir: string;
  // Replan from the registry identity so publisher/source changes cannot retarget deletion.
  requestedRef: string;
  version: string;
  installedAt: number;
  targetDir: string;
};

export type ClawHubSkillUninstallPlanResult =
  | { ok: true; plan: ClawHubSkillUninstallPlan }
  | {
      ok: false;
      code: "missing" | "ambiguous" | "modified";
      error: string;
    };

export type SkillSourceOrigin = {
  version: 1;
  source: "path" | "git";
  spec: string;
  slug: string;
  installedAt: number;
  git?: {
    url: string;
    ref?: string;
    commit?: string;
    resolvedAt: string;
  };
};

export type CommittedSkillChange = {
  action: PluginHookSkillChangedEvent["action"];
  source: PluginHookSkillChangedEvent["source"];
  workspaceDir: string;
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
  proposal?: PluginHookSkillChangedEvent["proposal"];
  logger?: { warn?: (message: string) => void };
};

export type WorkspaceSkillLifecycle = {
  installSkillDependencies: (params: {
    skillKey: string;
    spec: SkillInstallSpec;
    preferences: SkillsInstallPreferences;
    timeoutMs: number;
  }) => Promise<SkillInstallResult>;
  applyExtractedSkillRoot: (
    params: SkillRootInstallFiles & {
      changes?: {
        source: PluginHookSkillChangedEvent["source"];
        sourceVersion?: string;
      };
      beforeInstall?: (
        mode: "install" | "update",
      ) => Promise<{ error: string; failureKind: SkillArchiveInstallFailureKind } | undefined>;
    },
  ) => Promise<SkillRootApplyResult>;
  recordSkillSourceInstall: (params: {
    workspaceDir: string;
    targetDir: string;
    origin: SkillSourceOrigin;
  }) => Promise<void>;
  resolveClawHubSkillVerificationTarget: (params: {
    workspaceDir: string;
    slug: string;
    version?: string;
    tag?: string;
    baseUrl?: string;
  }) => Promise<ClawHubSkillVerificationTargetResult>;
  preflightSkillOwnerState: (params: {
    workspaceDir: string;
    requested: ClawHubSkillRef;
    requestedLabel: string;
    version: string;
    integrity: string;
  }) => Promise<ClawHubSkillInstallPreflightResult>;
  resolveRequestedUpdateSlug: (params: {
    workspaceDir: string;
    requestedSlug: string;
    lock: ClawHubSkillsLockfile;
  }) => Promise<string>;
  resolveTrackedUpdateTarget: (params: {
    workspaceDir: string;
    slug: string;
    lock: ClawHubSkillsLockfile;
    baseUrl?: string;
  }) => Promise<TrackedUpdateTarget>;
  readClawHubSkillsLockfile: (workspaceDir: string) => Promise<ClawHubSkillsLockfile>;
  recordClawHubSkillInstall: (params: {
    workspaceDir: string;
    skillDir: string;
    origin: ClawHubSkillOrigin;
    verification?: ClawHubSkillVerificationLock;
  }) => Promise<void>;
  assertClawHubSkillInstallState: (params: {
    workspaceDir: string;
    slug: string;
    force?: boolean;
  }) => Promise<void>;
  readInstalledClawHubSkillFiles: (params: {
    skillDir: string;
  }) => Promise<{ fileTreeSha256: string; skillFile?: ClawHubSkillFileLock }>;
  planClawHubSkillUninstall: (params: {
    workspaceDir: string;
    slug: string;
    expectedVersion: string;
  }) => Promise<ClawHubSkillUninstallPlanResult>;
  guardTrackedSkillLocalState: (params: {
    workspaceDir: string;
    slug: string;
    previousVersion: string | null;
  }) => Promise<
    { ok: true; plan: ClawHubSkillUninstallPlan | undefined } | { ok: false; error: string }
  >;
  applyClawHubSkillUninstall: (
    plan: ClawHubSkillUninstallPlan,
    options: {
      beforePersistentApply?: () => void;
      beforeRollback?: () => void;
      onCommittedChange?: (params: CommittedSkillChange) => Promise<void>;
    },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export type ClawHubSkillStatusLink =
  | (Omit<ClawHubSkillOrigin, "version"> & {
      status: "linked";
      valid: true;
      originPath: string;
      lockPath: string;
    })
  | {
      status: "invalid";
      valid: false;
      reason: string;
      registry?: string;
      slug?: string;
      installedVersion?: string;
      installedAt?: number;
      originPath?: string;
      lockPath?: string;
    };

export type LocalSkillCardStatus = {
  present: true;
  path: string;
  sizeBytes: number;
};
