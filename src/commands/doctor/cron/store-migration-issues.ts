export type CronStoreIssueKey =
  | "jobId"
  | "missingId"
  | "nonStringId"
  | "legacyScheduleString"
  | "legacyScheduleCron"
  | "legacyPayloadKind"
  | "legacyPayloadCodexModel"
  | "legacyAgentTurnCommandPayload"
  | "unresolvedAgentTurnShellToolPrompt"
  | "legacyPayloadProvider"
  | "legacyTopLevelPayloadFields"
  | "legacyTopLevelDeliveryFields"
  | "legacyDeliveryMode"
  | "migratedScheduledToolPolicy"
  | "migratedScheduledNativePolicy"
  | "migratedScheduledNativePolicyDisabled"
  | "invalidSchedule"
  | "invalidPayload";

export type CronStoreIssues = Partial<Record<CronStoreIssueKey, number>>;
