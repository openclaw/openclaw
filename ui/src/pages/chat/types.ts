export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ChatQueueSkillWorkshopRevision = {
  proposalId: string;
  agentId?: string;
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  kind?: "queued" | "steered";
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
  localCommandArgs?: string;
  localCommandName?: string;
  pendingRunId?: string;
  sendAttempts?: number;
  sendError?: string;
  sendRunId?: string;
  sendState?: "waiting-model" | "sending" | "waiting-reconnect" | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
};

export type ChatSessionRefreshTarget = {
  sessionKey: string;
  agentId?: string;
};
