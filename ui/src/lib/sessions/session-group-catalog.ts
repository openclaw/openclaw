import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type {
  SessionsGroupsDefaultsResult,
  SessionsGroupsListResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { formatUiError } from "../format-error.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { mergeSessionGroupDefaults, type SessionGroupSettings } from "./custom-groups.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionGateway,
  SessionGroupDefaultsStatus,
  SessionGroupMutationResult,
  SessionState,
} from "./session-types.ts";

type SessionGroupCatalogHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshRows: () => Promise<void>;
  notify: () => void;
  retryDelayMs: (error: unknown) => number | null;
};

const LEGACY_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";
const GROUPS_LIST_METHOD = "sessions.groups.list";
const GROUPS_DEFAULTS_METHOD = "sessions.groups.defaults";

function readLegacyStoredGroups(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      getSafeLocalStorage()?.getItem(LEGACY_GROUPS_STORAGE_KEY) ?? "[]",
    );
    return normalizeUniqueTrimmedStringList(parsed);
  } catch {
    // Malformed optional browser data must not block the canonical Gateway catalog.
    return [];
  }
}

export function createSessionGroupCatalog(host: SessionGroupCatalogHost) {
  let loadedEpoch = -1;
  let defaultsStatus: SessionGroupDefaultsStatus = "idle";
  let pendingLoad: Promise<readonly SessionGroupSettings[] | null> | null = null;
  let reorder:
    | {
        scope: SessionConnectionScope;
        order: readonly string[];
        write: Promise<SessionGroupMutationResult>;
      }
    | undefined;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const dispose = () => {
    loadedEpoch = -1;
    pendingLoad = null;
    clearRetry();
  };

  const invalidate = () => {
    dispose();
    defaultsStatus = "loading";
    host.publish({ ...host.readState() });
  };

  const publishCatalog = (
    groupSettings: readonly SessionGroupSettings[],
    sectionOrder: readonly string[],
    status: SessionGroupDefaultsStatus,
  ) => {
    defaultsStatus = status;
    host.publish({
      ...host.readState(),
      groups: groupSettings.map((group) => group.name),
      groupSettings,
      sectionOrder,
    });
  };

  const finishLoadFailure = (scope: SessionConnectionScope, error: unknown) => {
    if (!host.connection.isCurrent(scope)) {
      return null;
    }
    if (defaultsStatus !== "unavailable") {
      defaultsStatus = "unavailable";
      host.publish({ ...host.readState() });
    }
    loadedEpoch = -1;
    const delay = host.retryDelayMs(error);
    if (delay !== null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (host.connection.isCurrent(scope)) {
          void load();
        }
      }, delay);
    }
    return null;
  };

  const loadAttempt = async (scope: SessionConnectionScope, isCurrentLoad: () => boolean) => {
    try {
      const listed = await scope.client.request<SessionsGroupsListResult>(GROUPS_LIST_METHOD, {});
      if (!host.connection.isCurrent(scope) || !isCurrentLoad()) {
        return null;
      }
      let settings = listed.groups;
      let sectionOrder = listed.sectionOrder ?? [];
      // Browser-local catalogs predate the gateway store and migrate exactly once.
      const legacy = readLegacyStoredGroups();
      if (
        legacy.length > 0 &&
        readSessionMethodAccess(host.snapshot(), {
          method: "sessions.groups.put",
          requiredScope: "operator.write",
        }).allowed
      ) {
        if (settings.length === 0) {
          const put = await scope.client.request<SessionsGroupsListResult>("sessions.groups.put", {
            names: legacy,
          });
          if (!host.connection.isCurrent(scope)) {
            return null;
          }
          settings = put.groups;
          sectionOrder = put.sectionOrder ?? [];
        }
        try {
          getSafeLocalStorage()?.removeItem(LEGACY_GROUPS_STORAGE_KEY);
        } catch {
          // The gateway catalog is canonical even when browser cleanup fails.
        }
        if (!isCurrentLoad()) {
          return null;
        }
      }
      const defaultsAllowed = readSessionMethodAccess(host.snapshot(), {
        method: GROUPS_DEFAULTS_METHOD,
        requiredScope: "operator.write",
      }).allowed;
      if (!defaultsAllowed) {
        publishCatalog(settings, sectionOrder, "ready");
        return settings;
      }
      // The path-free catalog is independently useful to the sidebar. Defaults
      // readiness only gates group-target routes and must not erase those names.
      publishCatalog(settings, sectionOrder, "loading");
      const defaults = await scope.client.request<SessionsGroupsDefaultsResult>(
        GROUPS_DEFAULTS_METHOD,
        {},
      );
      if (!host.connection.isCurrent(scope) || !isCurrentLoad()) {
        return null;
      }
      settings = mergeSessionGroupDefaults(settings, defaults.defaults);
      publishCatalog(settings, sectionOrder, "ready");
      return settings;
    } catch (error) {
      return finishLoadFailure(scope, error);
    }
  };

  /** Share catalog loads per connection. */
  const load = async (): Promise<readonly SessionGroupSettings[] | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    if (loadedEpoch === scope.epoch) {
      return pendingLoad ?? host.readState().groupSettings;
    }
    clearRetry();
    loadedEpoch = scope.epoch;
    if (defaultsStatus !== "loading") {
      defaultsStatus = "loading";
      host.publish({ ...host.readState() });
    }
    // A catalog write retires older list/defaults reads before publishing its receipt.
    const promise: Promise<readonly SessionGroupSettings[] | null> = loadAttempt(
      scope,
      () => pendingLoad === promise,
    ).finally(() => {
      if (pendingLoad === promise) {
        pendingLoad = null;
      }
    });
    pendingLoad = promise;
    return promise;
  };

  const publishPathFreeMutation = (
    groupSettings: readonly SessionGroupSettings[],
    sectionOrder: readonly string[],
  ) => {
    // Catalog mutations do not carry authoritative defaults. Retire any older
    // defaults read and keep group routes blocked until a fresh read completes.
    invalidate();
    publishCatalog(groupSettings, sectionOrder, "loading");
    void load();
  };

  const mutate = async <T>(
    request: (client: SessionConnectionScope["client"]) => Promise<T>,
    apply: (result: T) => void,
  ): Promise<SessionGroupMutationResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "stale";
    }
    try {
      const result = await request(scope.client);
      if (!host.connection.isCurrent(scope)) {
        return "stale";
      }
      apply(result);
      return "completed";
    } catch (error) {
      if (!host.connection.isCurrent(scope)) {
        return "stale";
      }
      host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      throw error;
    }
  };

  const applyCatalogMutation = (
    result: SessionsGroupsListResult,
    defaults = host.readState().groupSettings,
  ) => {
    publishPathFreeMutation(
      mergeSessionGroupDefaults(result.groups, defaults),
      result.sectionOrder ?? [],
    );
  };

  const put = async (
    names: readonly string[],
    sectionOrder?: readonly string[],
  ): Promise<SessionGroupMutationResult> => {
    const send = () =>
      mutate(
        (client) =>
          client.request<SessionsGroupsListResult>("sessions.groups.put", {
            names,
            ...(sectionOrder === undefined ? {} : { sectionOrder }),
          }),
        applyCatalogMutation,
      );
    if (!sectionOrder) {
      return send();
    }
    const scope = host.connection.capture();
    if (!scope) {
      return "stale";
    }
    // Show every drop immediately, but send replacement orders in gesture order.
    // The saved catalog stays untouched until the Gateway replies.
    const next = () => (host.connection.isCurrent(scope) ? send() : ("stale" as const));
    const write =
      reorder && host.connection.isCurrent(reorder.scope) ? reorder.write.then(next, next) : send();
    reorder = { scope, order: sectionOrder, write };
    host.notify();
    try {
      return await write;
    } finally {
      if (reorder?.write === write) {
        reorder = undefined;
        if (host.connection.isCurrent(scope)) {
          host.notify();
        }
      }
    }
  };

  const rename = (from: string, to: string) =>
    mutate(
      (client) =>
        client.request<SessionsGroupsListResult>("sessions.groups.rename", { name: from, to }),
      (result) => {
        const current = host.readState().groupSettings;
        const targetExists = current.some((group) => group.name === to);
        const renamedDefaults = current.flatMap((group) =>
          group.name === from ? (targetExists ? [] : [{ ...group, name: to }]) : [group],
        );
        applyCatalogMutation(result, renamedDefaults);
        // Mutation response commits before a background member-row reconciliation.
        void host.refreshRows();
      },
    );

  const remove = (name: string) =>
    mutate(
      (client) => client.request<SessionsGroupsListResult>("sessions.groups.delete", { name }),
      (result) => {
        applyCatalogMutation(result);
        void host.refreshRows();
      },
    );

  const update = (name: string, defaults: { cwd: string | null; worktree: boolean }) =>
    mutate(
      (client) =>
        client.request<SessionsGroupsDefaultsResult>("sessions.groups.update", {
          name,
          ...defaults,
        }),
      (result) => {
        const state = host.readState();
        publishCatalog(
          mergeSessionGroupDefaults(state.groupSettings, result.defaults),
          state.sectionOrder,
          "ready",
        );
      },
    );

  return {
    delete: remove,
    dispose,
    invalidate,
    load,
    get pendingSectionOrder() {
      return reorder && host.connection.isCurrent(reorder.scope) ? reorder.order : undefined;
    },
    put,
    rename,
    status: () => defaultsStatus,
    update,
  };
}
