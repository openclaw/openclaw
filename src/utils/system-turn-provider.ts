const SYNTHETIC_SESSION_EVENT_PROVIDERS = new Set(["heartbeat", "cron-event", "exec-event"]);

export function isSyntheticSessionEventProvider(provider?: string): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized ? SYNTHETIC_SESSION_EVENT_PROVIDERS.has(normalized) : false;
}
