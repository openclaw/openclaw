import type { WorkerMachineResources } from "../../plugins/types.js";
export class WorkerSessionAlreadyAttachedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly environmentId: string,
  ) {
    super(`Session ${sessionId} is already attached to worker environment ${environmentId}`);
  }
}

export type WorkerEnvironmentSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  sessionLifecycleRevision?: string;
  /** Authenticated human principal, never accepted from request parameters. */
  principalId?: string;
  /** Host-derived restriction; never accepted from a machine request. */
  requiresIsolatedEnvironment?: true;
};

/** A secondary machine owned by a conversation, independent of its execution placement. */
export type WorkerEnvironmentAttachment = WorkerEnvironmentSessionIdentity & {
  environmentId: string;
  ownerEpoch: number;
  generation: number;
  /** Tool-only disposable guest lease; never an inference placement. */
  guest?: true;
};

export type WorkerEnvironmentAttachmentRecord = Omit<WorkerEnvironmentAttachment, "ownerEpoch"> & {
  createdAtMs: number;
  lastUsedAtMs: number;
  closedAtMs: number | null;
};

export type WorkerEnvironmentSessionCreateRequest = WorkerEnvironmentSessionIdentity & {
  profileId: string;
  idempotencyKey: string;
  machineClass?: string;
  resources?: WorkerMachineResources;
  os?: string;
  guest?: import("./session-guest.js").SessionGuestBinding;
};

/** Requester presentation must succeed before a newly reserved machine can be allocated. */
export type WorkerEnvironmentSessionReservationHandler = (reservation: {
  environmentId: string;
  reused: boolean;
}) => Promise<void>;
