export function createTelegramIngressPressure() {
  return [
    {
      channelId: "telegram",
      accountId: "ops",
      laneCount: 1,
      pendingCount: 56,
      claimedCount: 0,
      blockedCount: 55,
      oldestReceivedAt: 1_000,
    },
  ];
}
