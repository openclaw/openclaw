export type WorkObjectKind = "subagent" | "cron" | "manual" | "external";

export type WorkObjectStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "cancelled"
  | "needs_review";

export type WorkObjectEvidenceKind =
  | "text"
  | "file"
  | "url"
  | "session"
  | "command"
  | "test"
  | "metric"
  | "artifact";

export type WorkObjectEvidence = {
  id: string;
  kind: WorkObjectEvidenceKind;
  label: string;
  value?: string;
  path?: string;
  url?: string;
  atMs: number;
  metadata?: Record<string, unknown>;
};

export type WorkObjectWorkerRole = "implementer" | "reviewer" | "verifier" | "judge";

export type WorkObjectWorkerEngine =
  | "codex"
  | "claude-code"
  | "gemini-cli"
  | "openclaw"
  | "external";

export type WorkObjectWorkerRunStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export type WorkObjectWorkerVerdict = {
  status: "pass" | "warn" | "fail";
  summary: string;
};

export type WorkObjectWorkerRun = {
  id: string;
  role: WorkObjectWorkerRole;
  engine: WorkObjectWorkerEngine;
  label?: string;
  model?: string;
  modelStrategy?: "explicit" | "strongest_available" | "default";
  status: WorkObjectWorkerRunStatus;
  runId?: string;
  sessionKey?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  output?: string;
  verdict?: WorkObjectWorkerVerdict;
  evidence: WorkObjectEvidence[];
};

export type WorkObjectWorkerRequirement = {
  role: WorkObjectWorkerRole;
  engine: WorkObjectWorkerEngine;
  required: boolean;
  model?: string;
  modelStrategy?: "explicit" | "strongest_available" | "default";
  label?: string;
};

export type WorkObjectPolicy = {
  id: string;
  label: string;
  requirements: WorkObjectWorkerRequirement[];
  successRequires: "all_required_pass";
};

export type WorkObjectActor = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  workerId?: string;
};

export type WorkObjectRequester = {
  sessionKey?: string;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

export type WorkObjectSource = {
  type: "sessions_spawn" | "cron" | "gateway" | "cli" | "api" | "manual";
  id?: string;
  label?: string;
};

export type WorkObjectIsolation = {
  sessionKey?: string;
  workspace?: string;
  sandbox?: string;
};

export type WorkObjectRestartPolicy = "resume" | "redispatch" | "manual";

export type WorkObjectRecovery = {
  policy: WorkObjectRestartPolicy;
  attempts: number;
  lastRecoveredAtMs?: number;
  lastReason?: string;
};

export type WorkObjectMetrics = {
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  [key: string]: number | undefined;
};

export type ProofPacket = {
  id: string;
  workObjectId: string;
  status: WorkObjectStatus;
  summary: string;
  output?: string;
  evidence: WorkObjectEvidence[];
  workerRuns?: WorkObjectWorkerRun[];
  metrics?: WorkObjectMetrics;
  createdAtMs: number;
};

export type WorkObject = {
  id: string;
  kind: WorkObjectKind;
  title: string;
  goal: string;
  status: WorkObjectStatus;
  source: WorkObjectSource;
  actor?: WorkObjectActor;
  requester?: WorkObjectRequester;
  isolation?: WorkObjectIsolation;
  recovery: WorkObjectRecovery;
  workerPolicy?: WorkObjectPolicy;
  workerRuns: WorkObjectWorkerRun[];
  evidence: WorkObjectEvidence[];
  proofPacket?: ProofPacket;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  archivedAtMs?: number;
};

export type WorkObjectStoreFile = {
  version: 1;
  objects: Record<string, WorkObject>;
};

export type WorkObjectCreate = {
  id?: string;
  kind: WorkObjectKind;
  title: string;
  goal: string;
  status?: WorkObjectStatus;
  source: WorkObjectSource;
  actor?: WorkObjectActor;
  requester?: WorkObjectRequester;
  isolation?: WorkObjectIsolation;
  recovery?: Partial<WorkObjectRecovery>;
  workerPolicy?: WorkObjectPolicy;
  workerRuns?: Array<
    Omit<WorkObjectWorkerRun, "id" | "evidence"> &
      Partial<Pick<WorkObjectWorkerRun, "id" | "evidence">>
  >;
  evidence?: Array<
    Omit<WorkObjectEvidence, "id" | "atMs"> & Partial<Pick<WorkObjectEvidence, "id" | "atMs">>
  >;
  nowMs?: number;
};

export type WorkObjectPatch = Partial<
  Omit<
    WorkObject,
    | "id"
    | "createdAtMs"
    | "updatedAtMs"
    | "evidence"
    | "proofPacket"
    | "recovery"
    | "workerRuns"
    | "workerPolicy"
  >
> & {
  recovery?: Partial<WorkObjectRecovery>;
  workerPolicy?: WorkObjectPolicy;
  workerRuns?: Array<
    Omit<WorkObjectWorkerRun, "id" | "evidence"> &
      Partial<Pick<WorkObjectWorkerRun, "id" | "evidence">>
  >;
  evidence?: Array<
    Omit<WorkObjectEvidence, "id" | "atMs"> & Partial<Pick<WorkObjectEvidence, "id" | "atMs">>
  >;
  proofPacket?: ProofPacket;
  nowMs?: number;
};
