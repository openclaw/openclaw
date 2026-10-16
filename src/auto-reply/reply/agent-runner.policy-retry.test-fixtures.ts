export const successfulPolicyRetryCases = [
  {
    label: "direct chats",
    chatType: "direct",
    retryProvider: "openai",
    retryModel: "gpt-daybreak-blue-latest",
    expectedNotice: "↪️ Retried on Daybreak",
  },
  {
    label: "group chats",
    chatType: "group",
    retryProvider: "openai",
    retryModel: "gpt-daybreak-blue-latest",
    expectedNotice: "↪️ Retried on Daybreak",
  },
  {
    label: "channels",
    chatType: "channel",
    retryProvider: "openai",
    retryModel: "gpt-daybreak-blue-latest",
    expectedNotice: "↪️ Retried on Daybreak",
  },
  {
    label: "custom retry targets",
    chatType: "direct",
    retryProvider: "anthropic",
    retryModel: "claude-opus-4-7",
    expectedNotice: "↪️ Retried on anthropic/claude-opus-4-7",
  },
] as const;
