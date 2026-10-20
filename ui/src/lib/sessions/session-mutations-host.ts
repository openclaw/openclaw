import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { SessionCreateOutcome } from "./create.ts";
import type { SessionGateway, SessionRefreshOutcome } from "./session-capability.ts";
import type {
  PendingRowHost,
  PendingRowTarget,
  SessionPatchRowFact,
} from "./session-pending-rows.ts";
import type { SessionPermissionClaim } from "./session-permission-projection.ts";
import type { SessionRowLocalPatchHost } from "./session-row-local-patch.ts";
import type { createSessionRowProvenance } from "./session-row-provenance.ts";

export type SessionMutationsHost = Omit<PendingRowHost & SessionRowLocalPatchHost, "snapshot"> & {
  defer: ApplicationGateway["defer"];
  snapshot: () => SessionGateway["snapshot"];
  capturePatchFields: (
    target: Pick<PendingRowTarget, "key" | "agentId" | "sessionId">,
  ) => (fact: SessionPatchRowFact) => void;
  reconcileMutation: (
    agentId?: string | null,
    isErrorCurrent?: () => boolean,
    immediate?: boolean,
  ) => Promise<SessionRefreshOutcome>;
  publishedRow: (key: string) => GatewaySessionRow | undefined;
  archiveFields: Pick<ReturnType<typeof createSessionRowProvenance>, "inheritRow">;
  readRevision: () => number;
  notifyCreated: (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => void;
  clearThink: (key: string, agentId?: string | null) => void;
  suspendThink: (key: string, agentId?: string | null) => (() => void) | undefined;
  claimPermissionProjection: (
    key: string,
    agentId?: string | null,
    expectedSessionId?: string,
  ) => SessionPermissionClaim;
  retirePullRequestSummary: (key: string) => void;
};
