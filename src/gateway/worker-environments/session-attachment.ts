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
};

/** A secondary machine owned by a conversation, independent of its execution placement. */
export type WorkerEnvironmentAttachment = WorkerEnvironmentSessionIdentity & {
  environmentId: string;
  ownerEpoch: number;
  generation: number;
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
  os?: string;
};

/** Requester presentation must succeed before a newly reserved machine can be allocated. */
export type WorkerEnvironmentSessionReservationHandler = (reservation: {
  environmentId: string;
  reused: boolean;
}) => Promise<void>;
