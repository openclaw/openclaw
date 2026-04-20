export function createFeishuMessageActionBootstrapRegistryMock() {
  return (channel: string) =>
    channel === "feishu"
      ? {
          actions: {
            messageActionTargetAliases: {
              read: { aliases: ["messageId"] },
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
              "channel-info": { aliases: ["chatId"] },
            },
          },
        }
      : undefined;
}
