import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-bootstrap-contract.js";

export type ControlUiMockPreferenceScope = { key: string; profileId: string };

type PreferenceConnection = {
  url: string;
  readyState: number;
  preferenceScope: ControlUiMockPreferenceScope | null;
};

// Serialized alongside the Gateway mock; this owner retains server-side preferences.
export function createControlUiMockPreferences<Socket extends PreferenceConnection>(
  input: {
    seed: ControlUiBootstrapConfig["preferences"];
    methodResponses: Record<string, unknown>;
    hasRequestHandler: (method: string) => boolean;
    connections: () => Socket[];
    publish: (socket: Socket, payload: { profileId: string; keys: string[] }) => void;
  },
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  const hasOwn = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key);
  // This is the mock Gateway's durable state, separate from the browser's UI preferences.
  const userPreferencesStorageKey = "openclaw.control-ui-e2e.user-preferences.v1";
  const userPreferences = new Map<string, Record<string, unknown>>();
  try {
    const stored = window.sessionStorage.getItem(userPreferencesStorageKey);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (isRecord(parsed)) {
      for (const [key, entries] of Object.entries(parsed)) {
        if (isRecord(entries)) {
          userPreferences.set(key, entries);
        }
      }
    }
  } catch {
    // Storage-disabled contexts retain the current document's Gateway state.
  }
  function usesDefaultUserPreferences(method: string): boolean {
    return (
      (method === "users.prefs.get" || method === "users.prefs.set") &&
      !hasOwn(input.methodResponses, method) &&
      !input.hasRequestHandler(method)
    );
  }

  function samePreferenceValue(left: unknown, right: unknown): boolean {
    if (left === right) {
      return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      return (
        left.length === right.length &&
        left.every((value, index) => samePreferenceValue(value, right[index]))
      );
    }
    return (
      isRecord(left) &&
      isRecord(right) &&
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(
        ([key, value]) => hasOwn(right, key) && samePreferenceValue(value, right[key]),
      )
    );
  }

  function publishUserPreferenceCommit(
    socket: Socket,
    method: string,
    params: unknown,
    response: unknown,
  ): void {
    const scope = socket.preferenceScope;
    if (
      method !== "users.prefs.set" ||
      !usesDefaultUserPreferences(method) ||
      !scope ||
      !isRecord(response) ||
      response.status !== "ok" ||
      !isRecord(params) ||
      !isRecord(params.entries)
    ) {
      return;
    }
    const keys = Object.keys(params.entries);
    if (!keys.length) {
      return;
    }
    for (const connection of input.connections()) {
      if (connection.preferenceScope?.key === scope.key) {
        input.publish(connection, {
          profileId: scope.profileId,
          keys,
        });
      }
    }
  }

  return {
    usesDefault: usesDefaultUserPreferences,
    publish: publishUserPreferenceCommit,
    commit(
      socket: Socket,
      preferenceScope: ControlUiMockPreferenceScope | null,
      method: string,
      params: unknown,
      response: unknown,
    ): unknown {
      if (method === "connect" && isRecord(response) && response.type === "hello-ok") {
        const client = isRecord(params) && isRecord(params.client) ? params.client : null;
        const instanceId =
          typeof client?.instanceId === "string" ? client.instanceId : "e2e-self-instance";
        const snapshot = isRecord(response.snapshot) ? response.snapshot : null;
        const self = Array.isArray(snapshot?.presence)
          ? snapshot.presence.find(
              (entry: unknown) => isRecord(entry) && entry.instanceId === instanceId,
            )
          : undefined;
        const user = isRecord(self) && isRecord(self.user) ? self.user : null;
        const profileId = typeof user?.id === "string" ? user.id : null;
        socket.preferenceScope = null;
        if (profileId) {
          const endpoint = new URL(socket.url, window.location.href);
          const key = JSON.stringify([endpoint.origin, endpoint.pathname, profileId]);
          socket.preferenceScope = { key, profileId };
          if (!userPreferences.has(key)) {
            const seed = input.seed;
            userPreferences.set(key, seed?.profileId === profileId ? { ...seed.entries } : {});
          }
        }
      }
      if (usesDefaultUserPreferences(method)) {
        if (isRecord(response) && typeof response.status === "string" && response.status !== "ok") {
          return response;
        }
        if (method === "users.prefs.get" && isRecord(response) && hasOwn(response, "entries")) {
          return response;
        }
        if (!preferenceScope) {
          return { status: "no_durable_identity" };
        }
        if (socket.preferenceScope !== preferenceScope || socket.readyState !== WebSocket.OPEN) {
          return {
            __mockError: { code: "UNAVAILABLE", message: "User preference identity changed." },
          };
        }
        const entries = userPreferences.get(preferenceScope.key)!;
        if (method === "users.prefs.get") {
          const keys =
            isRecord(params) && Array.isArray(params.keys) ? params.keys : Object.keys(entries);
          return {
            status: "ok",
            entries: Object.fromEntries(
              keys
                .filter((key): key is string => typeof key === "string" && hasOwn(entries, key))
                .toSorted()
                .map((key) => [key, entries[key]]),
            ),
          };
        }
        if (
          isRecord(response) &&
          response.status === "ok" &&
          isRecord(params) &&
          isRecord(params.entries)
        ) {
          const expected = isRecord(params.expectedEntries) ? params.expectedEntries : {};
          if (
            Object.entries(expected).some(([key, value]) =>
              value === null
                ? hasOwn(entries, key)
                : !hasOwn(entries, key) || !samePreferenceValue(entries[key], value),
            )
          ) {
            return { status: "conflict" };
          }
          for (const [key, value] of Object.entries(params.entries)) {
            if (value === null) {
              delete entries[key];
            } else {
              entries[key] = value;
            }
          }
          try {
            window.sessionStorage.setItem(
              userPreferencesStorageKey,
              JSON.stringify(Object.fromEntries(userPreferences)),
            );
          } catch {
            // The acknowledged write still belongs to the current mock Gateway.
          }
        }
      }
      return response;
    },
  };
}
