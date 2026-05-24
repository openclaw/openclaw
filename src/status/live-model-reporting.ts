import type { SessionEntry } from "../config/sessions.js";

export type LiveStatusModelIdentity = { provider?: string; model: string };

export function resolveLiveStatusModelIdentity(params: {
  provider?: string;
  model?: string;
}): LiveStatusModelIdentity | undefined {
  const model = params.model?.trim();
  if (!model) {
    return undefined;
  }
  const provider = params.provider?.trim();
  return provider ? { provider, model } : { model };
}

export function withLiveStatusModelIdentity(
  entry: SessionEntry,
  identity: LiveStatusModelIdentity,
): SessionEntry {
  const next: SessionEntry = {
    ...entry,
    model: identity.model,
    ...(identity.provider ? { modelProvider: identity.provider } : {}),
  };
  if (!identity.provider) {
    delete next.modelProvider;
  }
  delete next.providerOverride;
  delete next.modelOverride;
  delete next.modelOverrideSource;
  return next;
}
