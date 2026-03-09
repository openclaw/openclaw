const managedDiscordSenderAccountByUserId = new Map<string, string>();

export function registerDiscordManagedSender(params: {
  userId?: string | null;
  accountId?: string | null;
}): void {
  const userId = params.userId?.trim();
  const accountId = params.accountId?.trim();
  if (!userId || !accountId) {
    return;
  }
  managedDiscordSenderAccountByUserId.set(userId, accountId);
}

export function unregisterDiscordManagedSender(params: {
  userId?: string | null;
  accountId?: string | null;
}): void {
  const userId = params.userId?.trim();
  if (!userId) {
    return;
  }
  const current = managedDiscordSenderAccountByUserId.get(userId);
  const accountId = params.accountId?.trim();
  if (!accountId || current === accountId) {
    managedDiscordSenderAccountByUserId.delete(userId);
  }
}

export function resolveDiscordManagedSenderAccountId(userId?: string | null): string | undefined {
  const normalized = userId?.trim();
  if (!normalized) {
    return undefined;
  }
  return managedDiscordSenderAccountByUserId.get(normalized);
}

export const __testing = {
  clear(): void {
    managedDiscordSenderAccountByUserId.clear();
  },
};
