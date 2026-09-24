import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SqliteLifecycleTargetSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import type { SessionEntryCanonicalReplacement } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import type {
  SessionPatchArchivePreparation,
  SessionPatchArchiveTarget,
} from "./sessions-patch-archive.js";
import type { createSessionPatchCatalogPreparation } from "./sessions-patch-catalog-preparation.js";
import type { ActiveSessionPermissionChange } from "./sessions-patch-permissions.runtime.js";
import type { GatewayRequestContext } from "./types.js";

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

export type MutationCoreResult =
  | { ok: false; error: ErrorShape }
  | {
      ok: true;
      cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      outcomes: MutationOutcome[];
      preparedByIndex: Array<PreparedPatchTarget | undefined>;
      catalogs: ReturnType<typeof createSessionPatchCatalogPreparation>;
    };
