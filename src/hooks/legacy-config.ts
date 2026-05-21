type LegacyInternalHookHandler = {
  event: string;
  module: string;
  export?: string;
};

type LegacyInternalHooksCarrier = {
  hooks?: {
    internal?: {
      handlers?: LegacyInternalHookHandler[];
    };
  };
};

export function getLegacyInternalHookHandlers(config: unknown): LegacyInternalHookHandler[] {
  const handlers = (config as LegacyInternalHooksCarrier)?.hooks?.internal?.handlers;
  return Array.isArray(handlers) ? handlers : [];
}
