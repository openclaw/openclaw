import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, onSettled, refresh } from "solid-js";
import { invalidateUserPreferences, saveUserPreferences } from "../../../app/user-prefs-cache.ts";
import { loadUserPreferences } from "../../../app/user-prefs-request.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { projectAgentSelection, projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";

type FavoriteSnapshot = { keys: readonly string[]; raw: unknown; ready: boolean; error?: string };
const empty: FavoriteSnapshot = { keys: [], raw: null, ready: false };

/** Membership lives in users.prefs; this picker only presents its scoped read and write outcome. */
export function createChatModelFavoritesScope(sessionKey: () => string) {
  const context = useOptionalApplication();
  const gateway = context && projectGateway(context.gateway);
  const selection = context && projectAgentSelection(context.agentSelection);
  const scope = createMemo(
    () => {
      const snapshot = gateway?.read().snapshot;
      const agentId =
        parseAgentSessionKey(sessionKey())?.agentId ?? selection?.read().state.selectedId;
      return snapshot?.client && snapshot.selfUser?.id && agentId && snapshot.phase === "connected"
        ? {
            client: snapshot.client,
            generation: snapshot.client.connectionGeneration,
            profileId: snapshot.selfUser.id,
            key: `ui.modelFavorites:${agentId}`,
          }
        : undefined;
    },
    {
      equals: (a, b) =>
        a?.client === b?.client &&
        a?.generation === b?.generation &&
        a?.profileId === b?.profileId &&
        a?.key === b?.key,
    },
  );
  return { context, scope };
}

export function createChatModelFavorites(owner: ReturnType<typeof createChatModelFavoritesScope>) {
  const { context, scope } = owner;
  let disposed = false;
  let inFlight: ReturnType<typeof scope>;
  const [pendingScope, setPendingScope] = createSignal<ReturnType<typeof scope>>();
  const current = (target: NonNullable<ReturnType<typeof scope>>) => {
    const snapshot = context?.gateway.snapshot;
    return (
      !disposed &&
      scope() === target &&
      snapshot?.client === target.client &&
      snapshot.client.connectionGeneration === target.generation &&
      snapshot.selfUser?.id === target.profileId &&
      snapshot.phase === "connected" &&
      canCallGatewayMethod(snapshot, "users.prefs.set", "operator.write")
    );
  };
  const snapshot = createMemo(
    async (): Promise<FavoriteSnapshot> => {
      const target = scope();
      if (!target) {
        return empty;
      }
      const unavailable = t("chat.modelControls.favoritesUnavailable");
      try {
        const result = await loadUserPreferences(target.client, target.profileId, {
          keys: [target.key],
        });
        if (result.status !== "ok") {
          return { ...empty, error: unavailable };
        }
        const raw = result.entries[target.key] ?? null;
        if (raw !== null && (!Array.isArray(raw) || !raw.every((key) => typeof key === "string"))) {
          return { ...empty, error: unavailable };
        }
        return { keys: raw ?? [], raw, ready: true };
      } catch (error) {
        return { ...empty, error: String(error) };
      }
    },
    { loadingValue: empty },
  );
  const [attempt, setAttempt] = createSignal<{
    scope: ReturnType<typeof scope>;
    result: Promise<void>;
  }>();
  const saving = () => Boolean(pendingScope() && pendingScope() === scope());
  const outcome = createMemo(
    () => {
      const pending = attempt();
      return pending?.scope === scope() ? pending?.result.then(() => null) : null;
    },
    { loadingValue: undefined },
  );
  async function toggle(key: string) {
    const target = scope();
    const observed = snapshot();
    if (!target || !current(target) || !observed.ready || inFlight === target) {
      return;
    }
    inFlight = target;
    setPendingScope(target);
    const nextKeys = observed.keys.includes(key)
      ? observed.keys.filter((entry) => entry !== key)
      : [...observed.keys, key];
    try {
      const result = await saveUserPreferences(target.client, {
        entries: { [target.key]: nextKeys.length ? nextKeys : null },
        expectedEntries: { [target.key]: observed.raw },
      });
      if (!current(target)) {
        return;
      }
      if (result.status !== "ok") {
        throw new Error(t("chat.modelControls.favoritesChanged"));
      }
    } finally {
      if (inFlight === target) {
        inFlight = undefined;
      }
      if (current(target)) {
        await refresh(snapshot);
      }
      if (pendingScope() === target) {
        setPendingScope(undefined);
      }
    }
  }
  onSettled(() => {
    const stop = context?.gateway.subscribeEvents((event) => {
      if (event.event !== "users.prefs.changed") {
        return;
      }
      const payload = asOptionalRecord(event.payload);
      const target = scope();
      // Delivery is already scoped to the authenticated profile and its aliases.
      if (target && Array.isArray(payload?.keys) && payload.keys.includes(target.key)) {
        invalidateUserPreferences(target.client);
        void refresh(snapshot);
      }
    });
    return () => {
      disposed = true;
      stop?.();
    };
  });
  return {
    snapshot,
    keys: () => snapshot().keys,
    saving,
    outcome,
    available: () => Boolean(scope()),
    disabled: () => saving() || !snapshot().ready || !scope() || !current(scope()!),
    toggle(key: string) {
      const target = scope();
      const result = toggle(key);
      void result.catch(() => {});
      setAttempt({ scope: target, result });
    },
    retry() {
      const target = scope();
      if (target) {
        invalidateUserPreferences(target.client);
      }
      void refresh(snapshot);
    },
  };
}
