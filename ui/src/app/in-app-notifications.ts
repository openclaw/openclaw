import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { invalidateUserPreferences, saveUserPreferences } from "./user-prefs-cache.ts";

const IN_APP_COMPLETION_PREFERENCE_KEY = "ui.notifications.otherSessionsFinished";

export type InAppNotificationsSnapshot = {
  enabled: boolean;
  loading: boolean;
  available: boolean;
  error: string | null;
};

export type InAppNotificationsCapability = {
  readonly snapshot: InAppNotificationsSnapshot;
  subscribe: (listener: () => void) => () => void;
  setEnabled: (enabled: boolean) => Promise<void>;
  dispose: () => void;
};

/** Account preferences are independent of browser/native notification permission. */
export function createInAppNotificationsCapability(
  gateway: ApplicationGateway,
): InAppNotificationsCapability {
  const snapshot: InAppNotificationsSnapshot = {
    enabled: false,
    loading: false,
    available: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let client: GatewayBrowserClient | null = null;
  let profileId: string | null = null;
  let hello = gateway.snapshot.hello;
  let generation = 0;
  let disposed = false;
  const publish = (patch: Partial<InAppNotificationsSnapshot>) => {
    Object.assign(snapshot, patch);
    for (const listener of listeners) {
      listener();
    }
  };
  const current = (owner: GatewayBrowserClient, profile: string, request: number) =>
    !disposed &&
    generation === request &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === owner &&
    gateway.snapshot.selfUser?.id === profile &&
    gateway.snapshot.hello === hello;
  const refresh = async () => {
    if (!client || !profileId) {
      return;
    }
    const owner = client;
    const profile = profileId;
    const request = ++generation;
    publish({ loading: true, error: null });
    try {
      const { loadUserPreferences } = await import("./user-prefs-request.ts");
      if (!current(owner, profile, request)) {
        return;
      }
      const result = await loadUserPreferences(owner, profile, {
        keys: [IN_APP_COMPLETION_PREFERENCE_KEY],
      });
      if (!current(owner, profile, request)) {
        return;
      }
      publish({
        enabled:
          result.status === "ok" && result.entries[IN_APP_COMPLETION_PREFERENCE_KEY] === true,
        available: result.status === "ok",
        loading: false,
      });
    } catch (error) {
      if (current(owner, profile, request)) {
        publish({ enabled: false, loading: false, error: formatUiError(error) });
      }
    }
  };
  const sync = () => {
    const nextClient = gateway.snapshot.phase === "connected" ? gateway.snapshot.client : null;
    const nextProfile = gateway.snapshot.selfUser?.id ?? null;
    if (client === nextClient && profileId === nextProfile && hello === gateway.snapshot.hello) {
      return;
    }
    client = nextClient;
    profileId = nextProfile;
    hello = gateway.snapshot.hello;
    generation++;
    publish({ enabled: false, available: false, loading: false, error: null });
    if (client) {
      invalidateUserPreferences(client);
    }
    void refresh();
  };
  const stopGateway = gateway.subscribe(sync);
  const stopEvents = gateway.subscribeEvents((event) => {
    const payload = event.payload;
    if (
      event.event !== "users.prefs.changed" ||
      !client ||
      !payload ||
      typeof payload !== "object" ||
      !("profileId" in payload) ||
      payload.profileId !== profileId ||
      !("keys" in payload) ||
      !Array.isArray(payload.keys) ||
      !payload.keys.includes(IN_APP_COMPLETION_PREFERENCE_KEY)
    ) {
      return;
    }
    invalidateUserPreferences(client);
    void refresh();
  });
  sync();
  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setEnabled(enabled) {
      if (disposed || !client || !profileId || !snapshot.available || snapshot.loading) {
        return;
      }
      const owner = client;
      const profile = profileId;
      const request = ++generation;
      if (!current(owner, profile, request)) {
        return;
      }
      publish({ loading: true, error: null });
      try {
        const result = await saveUserPreferences(owner, {
          entries: { [IN_APP_COMPLETION_PREFERENCE_KEY]: enabled },
        });
        if (!current(owner, profile, request)) {
          return;
        }
        publish({
          enabled: result.status === "ok" && enabled,
          available: result.status === "ok",
          loading: false,
        });
      } catch (error) {
        if (current(owner, profile, request)) {
          publish({ loading: false, error: formatUiError(error) });
        }
      }
    },
    dispose() {
      disposed = true;
      generation++;
      stopGateway();
      stopEvents();
      listeners.clear();
    },
  };
}
