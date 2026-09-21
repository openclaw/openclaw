import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCreateOutcome } from "./create.ts";
import type { SessionRefreshOutcome } from "./session-capability.ts";
import type {
  PendingRowHost,
  PendingRowTarget,
  SessionPatchRowFact,
} from "./session-pending-rows.ts";
import type { SessionPermissionClaim } from "./session-permission-projection.ts";
import type { SessionRowLocalPatchHost } from "./session-row-local-patch.ts";
import type { createSessionRowProvenance } from "./session-row-provenance.ts";

export type SessionMutationsHost = PendingRowHost &
  SessionRowLocalPatchHost & {
    capturePatchFields: (
      target: Pick<PendingRowTarget, "key" | "agentId" | "sessionId">,
    ) => (fact: SessionPatchRowFact) => void;
    reconcileMutation: (
      agentId?: string | null,
      isErrorCurrent?: () => boolean,
    ) => Promise<SessionRefreshOutcome>;
    publishedRow: (key: string) => GatewaySessionRow | undefined;
    archiveFields: Pick<
      ReturnType<typeof createSessionRowProvenance>,
      "fieldObservation" | "observeFields" | "inheritRow" | "mergeRow"
    >;
    readRevision: () => number;
    notifyCreated: (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => void;
    clearThink: (key: string, agentId?: string | null) => void;
    claimPermissionProjection: (
      key: string,
      agentId?: string | null,
      expectedSessionId?: string,
    ) => SessionPermissionClaim;
    retirePullRequestSummary: (key: string) => void;
  };
