export type ChatDefaultModelRecovery = {
  modelLabel: string;
  switchModel: () => Promise<boolean>;
};

export type ChatDefaultModelRecoveryReader = (
  create: typeof import("./chat-default-model-recovery.ts").createChatDefaultModelRecovery,
) => ChatDefaultModelRecovery | undefined;
