import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { formatUiError } from "../format-error.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import {
  readSessionCustomGroups,
  readSidebarSectionOrder,
  mergeSessionGroupDefaults,
  type SessionGroupSettings,
} from "./custom-groups.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionGateway,
  SessionGroupDefaultsStatus,
  SessionGroupMutationResult,
  SessionState,
} from "./session-capability.ts";

type SessionGroupCatalogHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshRows: () => Promise<void>;
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
    return [];
  }
}

export function createSessionGroupCatalog(host: SessionGroupCatalogHost) {
  let loadedEpoch = -1;
  let defaultsStatus: SessionGroupDefaultsStatus = "idle";
  let pendingLoad: Promise<readonly SessionGroupSettings[] | null> | null = null;
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
      groupSettings: [...groupSettings],
      sectionOrder: [...sectionOrder],
    });
  };

  const finishLoadFailure = (scope: SessionConnectionScope, error: unknown, retry: boolean) => {
    if (!host.connection.isCurrent(scope)) {
      return null;
    }
    if (defaultsStatus !== "unavailable") {
      defaultsStatus = "unavailable";
      host.publish({ ...host.readState() });
    }
    if (!retry) {
      return null;
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

  const loadAttempt = async (
    scope: SessionConnectionScope,
    advertised: boolean | null,
    isCurrentLoad: () => boolean,
  ) => {
    try {
      const listed = await scope.client.request(GROUPS_LIST_METHOD, {});
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      let settings = readSessionCustomGroups(listed);
      let sectionOrder = readSidebarSectionOrder(listed);
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
          // Legacy import replaces persisted groups; an invalidated read cannot authorize it.
          if (!isCurrentLoad()) {
            return null;
          }
          const put = await scope.client.request("sessions.groups.put", { names: legacy });
          if (!host.connection.isCurrent(scope)) {
            return null;
          }
          settings = readSessionCustomGroups(put);
          sectionOrder = readSidebarSectionOrder(put);
        }
        try {
          getSafeLocalStorage()?.removeItem(LEGACY_GROUPS_STORAGE_KEY);
        } catch {
          // The gateway catalog is canonical even when browser cleanup fails.
        }
      }
      const defaultsAllowed =
        isGatewayMethodAdvertised(host.snapshot(), GROUPS_DEFAULTS_METHOD) === true &&
        readSessionMethodAccess(host.snapshot(), {
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
      try {
        const defaults = await scope.client.request(GROUPS_DEFAULTS_METHOD, {});
        if (!host.connection.isCurrent(scope)) {
          return null;
        }
        settings = mergeSessionGroupDefaults(settings, defaults);
      } catch (error) {
        return finishLoadFailure(scope, error, true);
      }
      publishCatalog(settings, sectionOrder, "ready");
      return settings;
    } catch (error) {
      // Gateways without feature metadata retain the legacy one-shot probe.
      return finishLoadFailure(scope, error, advertised === true);
    }
  };

  /** Group consumers may probe once per connection; explicitly absent features never probe. */
  const load = async (): Promise<readonly SessionGroupSettings[] | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    if (loadedEpoch === scope.epoch) {
      return pendingLoad ?? host.readState().groupSettings;
    }
    const advertised = isGatewayMethodAdvertised(host.snapshot(), GROUPS_LIST_METHOD);
    clearRetry();
    loadedEpoch = scope.epoch;
    if (defaultsStatus !== "loading") {
      defaultsStatus = "loading";
      host.publish({ ...host.readState() });
    }
    if (advertised === false) {
      publishCatalog([], [], "ready");
      return [];
    }
    // Concurrent catalog changes settle best effort until the next invalidation or reconnect.
    const promise: Promise<readonly SessionGroupSettings[] | null> = loadAttempt(
      scope,
      advertised,
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

  const mutate = async (
    method: string,
    params: unknown,
    apply: (result: unknown) => void,
  ): Promise<SessionGroupMutationResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "stale";
    }
    try {
      const result = await scope.client.request(method, params);
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

  const applyCatalogMutation = (result: unknown, defaults = host.readState().groupSettings) => {
    publishPathFreeMutation(
      mergeSessionGroupDefaults(readSessionCustomGroups(result), { defaults }),
      readSidebarSectionOrder(result),
    );
  };

  const put = (names: readonly string[], sectionOrder?: readonly string[]) =>
    mutate(
      "sessions.groups.put",
      {
        names: [...names],
        ...(sectionOrder === undefined ? {} : { sectionOrder: [...sectionOrder] }),
      },
      applyCatalogMutation,
    );

  const rename = (from: string, to: string) =>
    mutate("sessions.groups.rename", { name: from, to }, (result) => {
      const current = host.readState().groupSettings;
      const targetExists = current.some((group) => group.name === to);
      const renamedDefaults = current.flatMap((group) =>
        group.name === from ? (targetExists ? [] : [{ ...group, name: to }]) : [group],
      );
      applyCatalogMutation(result, renamedDefaults);
      // Mutation response commits before a background member-row reconciliation.
      void host.refreshRows();
    });

  const remove = (name: string) =>
    mutate("sessions.groups.delete", { name }, (result) => {
      applyCatalogMutation(result);
      void host.refreshRows();
    });

  const update = (name: string, defaults: { cwd: string | null; worktree: boolean }) =>
    mutate("sessions.groups.update", { name, ...defaults }, (result) => {
      const state = host.readState();
      publishCatalog(
        mergeSessionGroupDefaults(state.groupSettings, result),
        state.sectionOrder,
        "ready",
      );
    });

  return {
    delete: remove,
    dispose,
    invalidate,
    load,
    put,
    rename,
    status: () => defaultsStatus,
    update,
  };
}
