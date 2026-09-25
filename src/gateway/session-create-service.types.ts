import type { Result } from "@openclaw/normalization-core/result";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { ErrorShape, SessionVisibility } from "../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ModelRef } from "../agents/model-selection.js";
import type {
  InternalSessionEntry,
  SessionEntry,
  SessionToolOverrides,
} from "../config/sessions.js";
import type { SessionEntryCreateWithTranscriptOptions } from "../config/sessions/session-accessor.types.js";
import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentRuntimeSpawnModelAutoSelection } from "./agent-runtime-session-spawn-context.js";
import type {
  ModelAccountConnectAction,
  UserModelAccountSelection,
} from "./model-account-authority.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";

type TrustedCatalogSessionTarget = {
  model: string;
  agentRuntime: string;
  pluginOwnerId: string;
};

export type GatewaySessionTitleModelSelection = Pick<
  InternalSessionEntry,
  "agentRuntimeOverride" | "authProfileOverride" | "modelOverride" | "providerOverride"
>;

export type PreparedGatewaySessionLifecycle = {
  spawnedCwd?: string;
  sessionRoot?: string;
  worktree?: NonNullable<InternalSessionEntry["worktree"]>;
  repositoryWorkspaceId?: string;
  pendingWorktree?: InternalSessionEntry["pendingWorktree"];
  /** Reacquire source custody only around the final persistence operation. */
  withCommit?: <T>(run: (assertSourceCurrent: () => void) => Promise<T>) => Promise<T>;
  rollback?: () => Promise<void>;
};

export type PrepareGatewaySessionLifecycle = (target: {
  agentId: string;
  entry?: InternalSessionEntry;
  key: string;
  storePath: string;
  titleModelSelection?: GatewaySessionTitleModelSelection | null;
  projectId?: string;
  /** Inherited or existing policy, resolved while the creation owner holds lifecycle custody. */
  sandboxRequired?: boolean;
}) => Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>>;

export type CreatedGatewaySession = {
  key: string;
  agentId: string;
  entry: SessionEntry;
  storePath: string;
  isNew: boolean;
};

type TrustedInitialSessionEntry = {
  agentHarnessId?: NonNullable<SessionEntry["agentHarnessId"]>;
  color?: string;
  pluginOwnerId?: string;
  providerOverride?: string;
  modelOverride?: string;
  modelOverrideRouteResolution?: "resolved";
  cliSessionBindings?: SessionEntry["cliSessionBindings"];
  initializationPending?: true;
  modelSelectionLocked?: true;
  pluginExtensions?: SessionEntry["pluginExtensions"];
};

export type GatewaySessionCommitResult =
  | {
      ok: true;
      key: string;
      agentId: string;
      entry: SessionEntry;
      resolved: { modelProvider: string; model: string };
      resetExisting: boolean;
    }
  | { ok: false; error: ErrorShape };

export type CreateGatewaySessionResult =
  | (Extract<GatewaySessionCommitResult, { ok: true }> & {
      postCommit: { status: "completed" } | { status: "failed"; error: unknown };
    })
  | Extract<GatewaySessionCommitResult, { ok: false }>;

export type CreateGatewaySessionParams = {
  cfg: OpenClawConfig;
  operatorAuthority?: Promise<
    | {
        authority: import("../agents/admitted-run-context.js").AdmittedRunOperatorAuthority;
      }
    | undefined
  >;
  getCurrentConfig?: () => OpenClawConfig;
  key?: string;
  agentId?: string;
  label?: string;
  /** Creation-only title seed; never renames an existing session. */
  displayName?: string;
  category?: string;
  model?: string;
  agentRuntime?: string;
  personalModelSelection?: UserModelAccountSelection;
  /** Direct human authority for defaults on a genuinely new row; never sourced from provenance. */
  personalAccountDefaults?: ModelAccountConnectAction;
  contextWindow?: string;
  thinkingLevel?: string;
  fastMode?: FastMode;
  /** Registry identity for a new session or a successfully recovered pending worktree. */
  projectId?: string;
  pendingProjectGitUrl?: string;
  pendingWorktree?: InternalSessionEntry["pendingWorktree"];
  incognito?: boolean;
  visibility?: SessionVisibility;
  /** Trusted catalog-owned model/runtime pair, persisted and locked together. */
  catalogTarget?: TrustedCatalogSessionTarget;
  parentSessionKey?: string;
  /**
   * Spawn-lineage depth declared by spawn-owned creations (visible subagent
   * sessions). Requires parentSessionKey. Omitted creations persist depth 0 so
   * operator sessions and forks stay spawn-capable roots.
   */
  spawnDepth?: number;
  /** Trusted effective policy captured by an in-process visible spawn. */
  spawnToolPolicy?: {
    version: 1;
    completionOwnerSessionKey?: string;
    allow: string[];
    deny: string[];
  };
  spawnedCwd?: string;
  sessionRoot?: string;
  /** Canonical agent default prepared by the RPC adapter, used only without a selected root. */
  defaultSessionRoot?: string;
  permissionMode?: SessionEntry["permissionMode"];
  toolOverrides?: SessionToolOverrides;
  /** Prepares session-owned resources while the target lifecycle fence is held. */
  prepareLifecycle?: PrepareGatewaySessionLifecycle;
  onLifecycleCleanupError?: (error: unknown) => void;
  /** Bind session exec to host=node with this node id; caller scope-checks. */
  execNode?: string;
  /** Working directory interpreted only by execNode. */
  execCwd?: string;
  /** Clear a prior node binding when a new Gateway-host session replaces it. */
  clearExecBinding?: boolean;
  clearSpawnedCwd?: boolean;
  fork?: boolean;
  forkFrom?: "last-completed";
  /** Live requester capability for an agent's current-transcript fork; never a wire parameter. */
  activeParentFork?: { requesterSessionKey: string; assertCurrent: () => void };
  /** Live spawn-owned selection; public model inputs remain raw. */
  preparedModelSelection?: { ref: ModelRef; assertCurrent: () => void };
  /**
   * Controls whether a distinct child terminates its parent. Omission preserves
   * the legacy rollover; callers use `false` for a parallel child.
   */
  succeedsParent?: boolean;
  emitCommandHooks?: boolean;
  resetMainWhenUnspecified?: boolean;
  commandSource: string;
  loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
  /** Trusted in-process initializer; never populated from public Gateway params. */
  initialEntry?: TrustedInitialSessionEntry;
  /** Keep a new ordinary session unusable until afterCreate succeeds, or roll it back. */
  atomicInitialization?: true;
  /** Public callers need admin before reconfiguring an adopted keyed session. */
  allowExistingModelSelection?: boolean;
  /** Admitted operator scopes; omitted only by trusted in-process callers. */
  requestingOperatorScopes?: readonly string[];
  /** Authenticated durable operator identity; absent for trusted in-process callers. */
  requestingOperatorProfileId?: string;
  /** Trusted host actor; only system-owned callers may omit operator identity. */
  operatorRoleActor?: GatewayOperatorRoleActor;
  /** Trusted in-process creation provenance; never populated from public Gateway params. */
  creation?: {
    via: SessionCreatedVia;
    actor?: SessionCreatedActor;
    /** Host-verified human requester for matching spawn-owner inheritance. */
    requesterProfileId?: string;
    sandbox?: "required";
    skillLibrarySelections?: import("../../packages/gateway-protocol/src/schema/skill-library.js").SkillLibrarySelection[];
    /** Trusted config-resolved spawn model provenance for the `model` field. */
    spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
  };
  /** Exact harness namespace authorized by the scoped plugin runtime. */
  authorizedAgentHarnessId?: string;
  /** Exact plugin namespace authorized by the scoped plugin runtime. */
  authorizedPluginId?: string;
  /** Arms local checkout attribution in the authoritative create/reset commit. */
  armSessionDiffBaselineCapture?: boolean;
  afterCreate?: (created: CreatedGatewaySession) => Promise<void>;
  /** Non-throwing notification of the exact newly committed row, before initial-turn work. */
  onCreatedSessionCommitted?: (created: CreatedGatewaySession) => void;
  afterSessionCommitted?: SessionEntryCreateWithTranscriptOptions["afterCommitted"];
  /** Synchronous caller-authority guard checked by each durable owner boundary. */
  commitGuard?: () => void;
};
