import { t } from "../../lib/reactive/i18n.ts";

type StatusGroup = { ready?: boolean; activeProvider?: string | null };
type StatusProvider = { id: string; configured?: boolean };

/**
 * One provider's status, from the strongest fact the catalog has. A group's `ready` is applied
 * after runtime provider selection, so it speaks for the active provider; it is absent on older
 * Gateways and for the speech group. Every other provider only has `configured`, which says its
 * credentials exist, not that it can run.
 */
export function talkProviderStatus(group: StatusGroup | undefined, provider: StatusProvider) {
  if (group?.ready !== undefined && group.activeProvider === provider.id) {
    return group.ready ? "ready" : provider.configured === false ? "notConfigured" : "notReady";
  }
  return provider.configured === false ? "notConfigured" : "configured";
}

export function talkProviderStatusLabel(status: ReturnType<typeof talkProviderStatus>) {
  return t(
    {
      ready: "talkPage.status.ready",
      configured: "talkPage.status.configured",
      notReady: "talkPage.transcription.providerNotReady",
      notConfigured: "talkPage.status.notReady",
    }[status],
  );
}
