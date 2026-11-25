import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SqliteLifecycleTargetSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import type { SessionEntryCanonicalReplacement } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import type {
  SessionPatchArchivePreparation,
  SessionPatchArchiveTarget,
} from "./sessions-patch-archive.types.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import type { ActiveSessionPermissionChange } from "./sessions-patch-permissions.runtime.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

export type MutationTarget = SessionPatchTargetIdentity & {
  commitGuard: () => ErrorShape | undefined;
};

export type PreparedPatchTarget = SessionPatchArchiveTarget & {
  archivePreparation?: SessionPatchArchivePreparation;
  index: number;
  targetAgentId: string;
  permissionChange?: ActiveSessionPermissionChange;
};

export type MutationOutcome =
  | {
      ok: true;
      applied: boolean;
      accessChanged: boolean;
      entry: SessionEntry;
    }
  | { ok: false; error: ErrorShape };

export type GroupMutationOperation = {
  replacements?: SessionEntryCanonicalReplacement[];
  result: GroupMutationResult;
};

type GroupMutationResult =
  | { kind: "model-catalog" }
  | { kind: "complete"; outcomes: MutationOutcome[] };

export type GroupAdmissionResult =
  | GroupMutationResult
  | { kind: "detached"; snapshot: SqliteLifecycleTargetSnapshot };

export type ExecuteSessionPatchMutationsParams = {
  client: GatewayClient | null;
  participationOnly?: boolean;
  context: GatewayRequestContext;
  signal?: AbortSignal;
  diagnostics?: SessionPatchDiagnostics;
  operatorAuthority?: Promise<{ authority: AdmittedRunOperatorAuthority } | undefined>;
  followSharingRegistration?: SessionMutationAuthorization["followRegistration"];
  readSessionSharing?: SessionMutationAuthorization["readTargetSharing"];
  onCreatedSessionCommitted?: SessionMutationAuthorization["recordCreatedSession"];
  patch: Omit<SessionsPatchParams, keyof SessionPatchTargetIdentity>;
  targets: readonly MutationTarget[];
};
