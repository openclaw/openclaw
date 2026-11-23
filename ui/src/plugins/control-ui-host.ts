import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiDisposer,
  ControlUiHost,
  ControlUiPageNavigationOptions,
  ControlUiPageTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import { isPluginInlineViewVersion } from "../../../src/shared/plugin-inline-view.js";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { isRouteId, pathForRoute, pluginTabLocation } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../app/operator-access.ts";
import {
  PLUGIN_PANEL_TOGGLE_EVENT,
  type PluginPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { i18n } from "../i18n/index.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { openPreferredApplicationSession } from "../lib/sessions/route-navigation.ts";
import {
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { createControlUiComponents } from "./control-ui-components.ts";
import { createPluginRecoveryStorage } from "./control-ui-recovery-storage.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

export function createControlUiPluginHost(
  getContext: () => ApplicationContext,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
): ControlUiHost {
  const current = () => {
    if (!runtime.isCurrent(owner)) {
      throw new Error("This plugin UI activation has ended. Use the current activation.");
    }
    return getContext();
  };
  const local = owner.descriptor.activation === "browser-local";
  const authenticated = () => {
    const context = current();
    if (local) {
      throw new Error("Browser-local plugin UI has no Gateway services.");
    }
    return context;
  };
  const retain = (dispose: ControlUiDisposer) => {
    if (!runtime.isCurrent(owner)) {
      dispose();
      current();
    }
    owner.disposers.add(dispose);
    return () => {
      owner.disposers.delete(dispose);
      dispose();
    };
  };
  const call = async <T>(operation: (context: ApplicationContext) => Promise<T>) => {
    const result = await operation(current());
    current();
    return result;
  };
  const callAuthenticated = <T>(operation: (context: ApplicationContext) => Promise<T>) =>
    call(() => operation(authenticated()));
  const pageLocation = (
    target: ControlUiPageTarget,
    options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
  ) => {
    const context = current();
    const tab = context.gateway.snapshot.hello?.controlUiTabs?.find(
      (candidate) => candidate.pluginId === owner.descriptor.pluginId && candidate.id === target.id,
    );
    const route = tab?.placement?.startsWith("route:")
      ? tab.placement.slice("route:".length)
      : null;
    const nativeRoute = route && isRouteId(route) ? route : null;
    const tabLocation = pluginTabLocation(
      tab ?? { pluginId: owner.descriptor.pluginId, id: target.id },
      context.basePath,
    );
    const path = nativeRoute ? pathForRoute(nativeRoute, context.basePath) : tabLocation.pathname;
    const suffix = nativeRoute ? target.path?.map(encodeURIComponent).join("/") : undefined;
    const search = new URLSearchParams(options?.preserveSearch ? window.location.search : "");
    if (!nativeRoute) {
      search.delete("plugin");
      search.delete("id");
      for (const [key, value] of new URLSearchParams(tabLocation.search)) {
        search.set(key, value);
      }
    }
    for (const [key, value] of Object.entries(target.params ?? {})) {
      search.set(`p.${key}`, value);
    }
    return {
      route: nativeRoute ?? ("plugin" as const),
      pathname: suffix ? `${path}/${suffix}` : path,
      search: search.size ? `?${search}` : "",
    };
  };
  const dock = local ? undefined : getContext().assistantDock;
  // Only an activation that actually docked a conversation owns a close-on-dispose.
  let dockCloseRetained = false;
  return {
    apiVersion: 1,
    pluginId: owner.descriptor.pluginId,
    signal: owner.abort.signal,
    get basePath() {
      return current().basePath;
    },
    get locale() {
      return i18n.getLocale();
    },
    redact: redactToolDetail,
    components: createControlUiComponents({
      current: authenticated,
      presentationCurrent: current,
      signal: owner.abort.signal,
      onError: (error) => runtime.reportError(owner.descriptor.pluginId, error),
    }),
    presentation: {
      version: 1,
      get branding() {
        return current().theme.branding;
      },
      translate(key, params) {
        current();
        return i18n.t(key, params);
      },
      async loadThemeArtwork(url) {
        const { fetchPluginThemeArtworkBlobUrl } = await import("../pages/plugins/icon-loader.ts");
        const context = current();
        if (
          local &&
          (context.gateway.snapshot.phase !== "connected" ||
            !Object.values(context.theme.branding.artwork?.critters ?? {}).some(
              (art) => art.url === url,
            ))
        ) {
          return null;
        }
        return fetchPluginThemeArtworkBlobUrl({ url });
      },
    },
    get connection() {
      if (local) {
        current();
        return {
          connected: false,
          canRead: false,
          canWrite: false,
          canGrant: false,
          canAdmin: false,
          assistantAgentId: null,
        };
      }
      const snapshot = authenticated().gateway.snapshot;
      const access = readGatewayOperatorAccess(snapshot);
      return {
        connected: snapshot.phase === "connected",
        canRead: hasOperatorReadAccess(snapshot.hello?.auth ?? null),
        canWrite: access.canWrite,
        canGrant: access.canGrantApprovals,
        canAdmin: access.canAdmin,
        assistantAgentId: snapshot.assistantAgentId,
      };
    },
    get recoveryStorage() {
      if (local) {
        current();
        return null;
      }
      authenticated();
      if (!owner.client) {
        return null;
      }
      return createPluginRecoveryStorage(
        current().gateway,
        owner.client,
        owner.descriptor.pluginId,
        () => {
          current();
        },
      );
    },
    request: (method, params = {}) =>
      call(() => {
        authenticated();
        if (!owner.client) {
          throw new Error("This plugin has no Gateway connection.");
        }
        return owner.client.request(method, params);
      }),
    onEvent(event, listener) {
      return retain(
        authenticated().gateway.subscribeEvents(
          (frame) => {
            if (
              runtime.isCurrent(owner) &&
              frame.event === event &&
              (event !== "session.message" || asOptionalRecord(frame.payload)?.message != null)
            ) {
              listener(frame.payload);
            }
          },
          { includeMessageBodies: event === "session.message" },
        ),
      );
    },
    subscribe(listener) {
      const context = current();
      const notify = () => {
        if (runtime.isCurrent(owner)) {
          listener();
        }
      };
      // The public SDK subscription delivers each owner publication within its activation.
      const stops = (
        local
          ? [context.theme, i18n]
          : [
              context.gateway,
              context.sessions,
              context.agents,
              context.agentSelection,
              context.theme,
              i18n,
              ...(dock ? [dock] : []),
            ]
      ).map((source) => source.subscribe(notify));
      return retain(() => stops.forEach((stop) => stop()));
    },
    sessions: {
      get rows() {
        if (local) {
          current();
          return [];
        }
        return structuredClone(authenticated().sessions.state.result?.sessions ?? []);
      },
      get selectedKey() {
        if (local) {
          current();
          return "";
        }
        return authenticated().gateway.snapshot.sessionKey;
      },
      normalizeKey: normalizeSessionKeyForUiComparison,
      refresh: () =>
        callAuthenticated(async (context) => {
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error("The session refresh did not complete. Try again.");
          }
        }),
      observe(query, listener) {
        const { archived, ...options } = query;
        let disposed = false;
        const observer = authenticated().sessions.observeList(
          {
            ...options,
            archivedFilter: archived === "all" ? "all" : archived ? "archived" : "active",
          },
          ({ result, loading, error }) => {
            if (disposed || !runtime.isCurrent(owner)) {
              return;
            }
            try {
              listener({
                loading,
                error,
                result: result
                  ? {
                      sessions: structuredClone(result.sessions),
                      hasMore: result.hasMore,
                      nextOffset: result.nextOffset,
                      totalCount: result.totalCount,
                    }
                  : null,
              });
            } catch (listenerError) {
              runtime.reportError(owner.descriptor.pluginId, listenerError);
            }
          },
        );
        const dispose = retain(() => {
          disposed = true;
          observer.dispose();
        });
        const refresh = () => callAuthenticated(() => observer.refresh());
        void refresh().catch((error: unknown) => {
          if (!disposed && runtime.isCurrent(owner)) {
            runtime.reportError(owner.descriptor.pluginId, error);
          }
        });
        return { refresh, dispose };
      },
      open({ sessionKey, agentId }) {
        openPreferredApplicationSession(authenticated(), sessionKey, agentId);
      },
      create: (params) =>
        callAuthenticated((context) =>
          context.sessions.create(params, { signal: owner.abort.signal }),
        ),
      patch: ({ sessionKey, agentId }, patch) =>
        callAuthenticated(async (context) => {
          // A plugin query may target another global owner. Its mutation does not
          // own the primary roster's optimistic model or remembered list scope.
          const result = await context.sessions.patch(sessionKey, patch, {
            agentId,
            ownsModelOverride: () => false,
            deferListRefresh: true,
          });
          if (!result) {
            throw new Error("The session update did not complete. Try again.");
          }
          authenticated();
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error(
              "The session was updated, but the session list could not be refreshed. Refresh the list to see the change.",
            );
          }
        }),
    },
    agents: {
      get rows() {
        if (local) {
          current();
          return [];
        }
        return structuredClone(authenticated().agents.state.agentsList?.agents ?? []);
      },
      get selectedId() {
        if (local) {
          current();
          return null;
        }
        return authenticated().agentSelection.state.selectedId;
      },
      get defaultId() {
        if (local) {
          current();
          return null;
        }
        return authenticated().agents.state.agentsList?.defaultId ?? null;
      },
      get scopeId() {
        if (local) {
          current();
          return null;
        }
        return authenticated().agentSelection.state.scopeId;
      },
      select(agentId) {
        authenticated().agentSelection.set(agentId);
      },
      setScope(agentId) {
        authenticated().agentSelection.setScope(agentId);
      },
      refresh: () =>
        callAuthenticated(async (context) => {
          if ((await context.agents.refreshList()) === null) {
            throw new Error("The agent refresh did not complete. Try again.");
          }
        }),
    },
    dock: dock
      ? {
          openSession(params) {
            authenticated().assistantDock.openSession(params, owner.abort);
            if (!dockCloseRetained) {
              dockCloseRetained = true;
              retain(() => dock.close(owner.abort));
            }
          },
          close() {
            authenticated().assistantDock.close();
          },
          get openSessionKey() {
            return authenticated().assistantDock.openSessionKey;
          },
        }
      : undefined,
    navigation: {
      openSettings(section) {
        current().navigate(section);
      },
      openPage(target, options) {
        const location = pageLocation(target, options);
        const context = current();
        if (options?.replace) {
          context.replace(location.route, location);
        } else {
          context.navigate(location.route, location);
        }
      },
      pageHref(target, options) {
        const location = pageLocation(target, options);
        return `${location.pathname}${location.search}`;
      },
    },
    ui: {
      invalidate: () => runtime.invalidate(owner),
      registerPage: (value) => runtime.register(owner, "pages", value),
      registerNavigation: (value) => runtime.register(owner, "navigation", value),
      pinNavigation(id) {
        const context = current();
        if (!owner.contributions.navigation.has(id)) {
          return;
        }
        const entry = serializeSidebarEntry({
          type: "plugin",
          key: `${owner.descriptor.pluginId}/${id}`,
        });
        const entries = context.navigation.snapshot.sidebarEntries;
        if (!entries.includes(entry)) {
          context.navigation.update({ sidebarEntries: [...entries, entry] });
        }
      },
      unpinNavigation(id) {
        const context = current();
        const entry = serializeSidebarEntry({
          type: "plugin",
          key: `${owner.descriptor.pluginId}/${id}`,
        });
        const entries = context.navigation.snapshot.sidebarEntries;
        if (entries.includes(entry)) {
          context.navigation.update({ sidebarEntries: entries.filter((value) => value !== entry) });
        }
      },
      isNavigationPinned(id) {
        return current().navigation.snapshot.sidebarEntries.includes(
          serializeSidebarEntry({ type: "plugin", key: `${owner.descriptor.pluginId}/${id}` }),
        );
      },
      registerPanel: (value) => runtime.register(owner, "panels", value),
      openPanel(id, session) {
        const context = authenticated();
        if (!owner.contributions.panels.has(id)) {
          throw new Error("A plugin can open only its own registered panel.");
        }
        const sessionKey = session?.sessionKey ?? context.gateway.snapshot.sessionKey;
        if (!sessionKey) {
          throw new Error("Select a session before opening a plugin panel.");
        }
        const detail: PluginPanelToggleDetail = {
          pluginId: owner.descriptor.pluginId,
          panelId: id,
          sessionKey,
          agentId:
            session?.agentId ??
            parseAgentSessionKey(sessionKey)?.agentId ??
            context.agentSelection.state.selectedId ??
            undefined,
          open: true,
        };
        const event = new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, { detail });
        rememberSessionPanelToggle(`plugin:${detail.pluginId}/${id}`, event);
        openPreferredApplicationSession(context, sessionKey, session?.agentId);
        window.dispatchEvent(event);
      },
      registerAction: (value) => runtime.register(owner, "actions", value),
      registerAccessory: (value) => runtime.register(owner, "accessories", value),
      registerWidget: (value) => runtime.register(owner, "widgets", value),
      registerInlineView: (value) => {
        if (!isPluginInlineViewVersion(value.version)) {
          throw new Error("Inline view version must be an integer from 1 to 65535.");
        }
        return runtime.register(owner, "inlineViews", value, value.id + "@" + value.version);
      },
      registerReplacement: (value) => runtime.register(owner, "replacements", value),
      selectReplacement(surface, id) {
        authenticated();
        if (id !== null && owner.contributions.replacements.get(id)?.value.surface !== surface) {
          throw new Error("A plugin can select only its own registered UI replacement.");
        }
        owner.selections.set(surface, id);
        if (
          runtime
            .registrations("replacements")
            .some((entry) => entry.host.signal === owner.abort.signal)
        ) {
          runtime.selectReplacement(
            surface,
            id === null ? null : `${owner.descriptor.pluginId}/${id}`,
          );
        }
      },
    },
  };
}
