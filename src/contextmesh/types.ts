export type ContextMeshPrivacyMode = "private_local" | "trusted_lan" | "public_mesh";

export type ContextMeshJobMode =
  | "summarize"
  | "qa"
  | "compress"
  | "keywords"
  | "entities"
  | "semantic_search";

export type ContextMeshTaskType =
  | "token_count"
  | "chunk_text"
  | "summarize_chunk"
  | "map_reduce_summary"
  | "extract_keywords"
  | "extract_entities"
  | "relevance_score"
  | "semantic_search"
  | "context_compression"
  | "question_answer_over_chunks"
  | "duplicate_chunk_detection";

export type ContextMeshWorkerStatus = "pending" | "approved" | "online" | "offline";
export type ContextMeshTaskStatus = "queued" | "assigned" | "completed" | "failed" | "cancelled";
export type ContextMeshJobStatus = "queued" | "running" | "completed" | "failed";

export type ContextMeshWorkerHardware = {
  hostname: string;
  os: string;
  cpuModel: string;
  cpuCores: number;
  ramMb: number;
  gpuModel?: string;
  vramMb?: number;
  cudaAvailable: boolean;
  driverVersion?: string;
  ollamaAvailable: boolean;
  llamaCppAvailable: boolean;
  embeddingModelAvailable: boolean;
};

export type ContextMeshWorkerRecord = {
  id: string;
  name: string;
  status: ContextMeshWorkerStatus;
  deviceId: string;
  pairingRequestId?: string;
  authTokenIssuedAtMs?: number;
  scopes: string[];
  hardwareFingerprint: string;
  hardware: ContextMeshWorkerHardware;
  protocolVersion: string;
  workerVersion: string;
  approvedAt?: string;
  lastHeartbeatAt?: string;
  currentTaskId?: string;
  currentTaskType?: ContextMeshTaskType;
  completedTasks: number;
  failedTasks: number;
  averageLatencyMs: number;
  chunksPerSecond: number;
  lastError?: string;
};

export type ContextMeshTaskPayload = {
  chunkId?: string;
  text?: string;
  query?: string;
  chunks?: string[];
  overlapTokens?: number;
  estimatedTokens?: number;
};

export type ContextMeshTaskRecord = {
  id: string;
  jobId: string;
  type: ContextMeshTaskType;
  status: ContextMeshTaskStatus;
  attempt: number;
  assignedWorkerId?: string;
  createdAt: string;
  updatedAt: string;
  timeoutAt?: string;
  payload: ContextMeshTaskPayload;
  result?: unknown;
  error?: string;
};

export type ContextMeshJobRecord = {
  id: string;
  runId?: string;
  mode: ContextMeshJobMode;
  status: ContextMeshJobStatus;
  createdAt: string;
  updatedAt: string;
  sourceFile?: string;
  question?: string;
  distributed: boolean;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  output?: string;
  taskLedgerStatus?: "running" | "succeeded" | "failed";
};

export type ContextMeshAuditRecord = {
  id: string;
  createdAt: string;
  workerId: string;
  taskId: string;
  jobId: string;
  taskType: ContextMeshTaskType;
  redactedPreview: string;
};

export type ContextMeshMetrics = {
  connectedWorkers: number;
  activeWorkers: number;
  totalJobs: number;
  activeJobs: number;
  completedTasks: number;
  failedTasks: number;
  retries: number;
  averageTaskLatencyMs: number;
  estimatedTokensProcessed: number;
  estimatedTokensPerSecond: number;
  distributedSpeedupRatio: number;
};

export type ContextMeshState = {
  config: {
    protocolVersion: string;
    allowSensitiveDistribution: boolean;
    privacyMode: ContextMeshPrivacyMode;
    maxChunkTokens: number;
    maxJobChars: number;
    heartbeatTimeoutMs: number;
    taskTimeoutMs: number;
  };
  workers: ContextMeshWorkerRecord[];
  jobs: ContextMeshJobRecord[];
  tasks: ContextMeshTaskRecord[];
  audit: ContextMeshAuditRecord[];
  metrics: ContextMeshMetrics;
};

export type ContextMeshWorkerHello = {
  type: "worker_hello";
  workerId: string;
  deviceId: string;
  deviceToken: string;
  name: string;
  workerVersion: string;
  protocolVersion: string;
  hardwareFingerprint: string;
  hardware: ContextMeshWorkerHardware;
};

export type ContextMeshWorkerHelloAck = {
  type: "worker_hello_ack";
  workerId: string;
  accepted: boolean;
  reason?: string;
  heartbeatIntervalMs?: number;
};

export type ContextMeshWorkerHeartbeat = {
  type: "worker_heartbeat";
  workerId: string;
};

export type ContextMeshWorkerTaskRequest = {
  type: "worker_task_request";
  workerId: string;
};

export type ContextMeshCoordinatorTaskAssign = {
  type: "coordinator_task_assign";
  task: ContextMeshTaskRecord | null;
};

export type ContextMeshWorkerTaskComplete = {
  type: "worker_task_complete";
  workerId: string;
  taskId: string;
  result: unknown;
  latencyMs?: number;
};

export type ContextMeshWorkerTaskFailed = {
  type: "worker_task_failed";
  workerId: string;
  taskId: string;
  error: string;
};

export type ContextMeshCoordinatorCancelTask = {
  type: "coordinator_cancel_task";
  taskId: string;
  reason?: string;
};

export type ContextMeshCoordinatorShutdown = {
  type: "coordinator_shutdown";
  reason?: string;
};

export type ContextMeshWorkerSocketMessage =
  | ContextMeshWorkerHello
  | ContextMeshWorkerHeartbeat
  | ContextMeshWorkerTaskRequest
  | ContextMeshWorkerTaskComplete
  | ContextMeshWorkerTaskFailed;

export type ContextMeshCoordinatorSocketMessage =
  | ContextMeshWorkerHelloAck
  | ContextMeshCoordinatorTaskAssign
  | ContextMeshCoordinatorCancelTask
  | ContextMeshCoordinatorShutdown;

export type ContextMeshTaskResult = {
  summary?: string;
  keywords?: string[];
  entities?: string[];
  relevance?: number;
  answer?: string;
  compressed?: string;
  tokenCount?: number;
  duplicates?: string[];
  matches?: Array<{ chunkId: string; score: number; excerpt: string }>;
};
