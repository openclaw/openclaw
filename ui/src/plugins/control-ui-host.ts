import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiDisposer,
  ControlUiPageNavigationOptions,
  ControlUiPageTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import { isPluginInlineViewVersion } from "../../../src/shared/plugin-inline-view.js";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { isRouteId, pathForRoute, pluginTabLocation } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../app/operator-access.ts";
import {
  PLUGIN_PANEL_TOGGLE_EVENT,
  type PluginPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { i18n } from "../i18n/index.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { openPreferredApplicationSession } from "../lib/sessions/route-navigation.ts";
import {
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  scopedSessionArtifactKey,
  uiSessionEventMatches,
} from "../lib/sessions/session-key.ts";
import { invokeControlUiAction } from "./control-ui-action-invocation.ts";
import type { PreparedControlUiHost } from "./control-ui-capability.ts";
import { createControlUiComponents } from "./control-ui-components.ts";
import { createControlUiNativeHost } from "./control-ui-native-host.tsx";
import { createControlUiPresentationHost } from "./control-ui-presentation-host.tsx";
import { createControlUiRequests } from "./control-ui-requests.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";
import { createTextReferenceProjection } from "./control-ui-text-references.solid.ts";

export function createControlUiPluginHost(
  getContext: () => ApplicationContext,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
): PreparedControlUiHost {
  const current = () => {
    if (!runtime.isCurrent(owner)) {
      throw new Error("This plugin UI activation has ended. Use the current activation.");
    }
    return getContext();
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
  const dock = getContext().assistantDock;
  // Only an activation that actually docked a conversation owns a close-on-dispose.
  let dockCloseRetained = false;
  const host: PreparedControlUiHost = {
    projectTextReferences: createTextReferenceProjection,
    scopeView: (signal, isCurrent) => scopeControlUiHost(host, signal, isCurrent),
    invokeAction: (action, registrationSignal, params, retry) => {
      current();
      return invokeControlUiAction(host, action, registrationSignal, params, retry);
    },
    apiVersion: 1,
    capabilitiesVersion: 2,
    pluginId: owner.descriptor.pluginId,
    signal: owner.abort.signal,
    get basePath() {
      return current().basePath;
    },
    get locale() {
      return i18n.getLocale();
    },
    redact: redactToolDetail,
    requests: createControlUiRequests({ current, signal: owner.abort.signal, retain }),
    native: createControlUiNativeHost(owner.abort.signal),
    presentation: createControlUiPresentationHost(current, owner.abort.signal),
    components: createControlUiComponents({
      current,
      signal: owner.abort.signal,
      onError: (error) => runtime.reportError(owner.descriptor.pluginId, error),
    }),
    get connection() {
      const gateway = current().gateway;
      const snapshot = gateway.snapshot;
      const access = readGatewayOperatorAccess(snapshot);
      return {
        connected: snapshot.phase === "connected",
        readScopeKey: JSON.stringify([
          gatewayPresentationScope(gateway).key,
          snapshot.hello?.auth?.role,
          [...(snapshot.hello?.auth?.scopes ?? [])].toSorted(),
          snapshot.hello?.features?.methods?.toSorted(),
        ]),
        canRead: hasOperatorReadAccess(snapshot.hello?.auth ?? null),
        canWrite: access.canWrite,
        canGrant: access.canGrantApprovals,
        canAdmin: access.canAdmin,
        assistantAgentId: snapshot.assistantAgentId,
      };
    },
    request: (method, params = {}) => call(() => owner.client.request(method, params)),
    onEvent(event, listener) {
      return retain(
        current().gateway.subscribeEvents(
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
      const stops = [
        context.gateway,
        context.sessions,
        context.agents,
        context.agentSelection,
        context.theme,
        i18n,
        ...(dock ? [dock] : []),
      ].map((source) => source.subscribe(notify));
      return retain(() => stops.forEach((stop) => stop()));
    },
    sessions: {
      methodAccess: (session, request) =>
        readSessionMethodAccess(current().gateway.snapshot, { ...request, session }).allowed,
      attachOperation: (row, factory) =>
        current().sessions.retainedOperations.attach(row, factory, owner.descriptor.pluginId, {
          signal: owner.abort.signal,
          onError: (error) => runtime.reportError(owner.descriptor.pluginId, error),
        }),
      artifactKey: ({ sessionKey, agentId }) => scopedSessionArtifactKey(sessionKey, agentId),
      agentId: (key) => parseAgentSessionKey(key)?.agentId,
      matches: ({ sessionKey, agentId }, eventKey, eventAgentId) => {
        const snapshot = current().gateway.snapshot;
        return uiSessionEventMatches(
          {
            assistantAgentId: agentId ?? snapshot.assistantAgentId,
            hello: snapshot.hello,
            sessionKey,
          },
          eventKey,
          eventAgentId,
        );
      },
      get rows() {
        return structuredClone(current().sessions.state.result?.sessions ?? []);
      },
      get selectedKey() {
        return current().gateway.snapshot.sessionKey;
      },
      normalizeKey: normalizeSessionKeyForUiComparison,
      refresh: () =>
        call(async (context) => {
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error("The session refresh did not complete. Try again.");
          }
        }),
      observe(query, listener) {
        const { archived, ...options } = query;
        let disposed = false;
        const observer = current().sessions.observeList(
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
        const refresh = () => call(() => observer.refresh());
        void refresh().catch((error: unknown) => {
          if (!disposed && runtime.isCurrent(owner)) {
            runtime.reportError(owner.descriptor.pluginId, error);
          }
        });
        return { refresh, dispose };
      },
      open({ sessionKey, agentId }) {
        openPreferredApplicationSession(current(), sessionKey, agentId);
      },
      create: (params) =>
        call((context) => context.sessions.create(params, { signal: owner.abort.signal })),
      patch: ({ sessionKey, agentId }, patch) =>
        call(async (context) => {
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
          current();
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error(
              "The session was updated, but the session list could not be refreshed. Refresh the list to see the change.",
            );
          }
        }),
    },
    agents: {
      get rows() {
        return structuredClone(current().agents.state.agentsList?.agents ?? []);
      },
      get selectedId() {
        return current().agentSelection.state.selectedId;
      },
      get defaultId() {
        return current().agents.state.agentsList?.defaultId ?? null;
      },
      get scopeId() {
        return current().agentSelection.state.scopeId;
      },
      select(agentId) {
        current().agentSelection.set(agentId);
      },
      setScope(agentId) {
        current().agentSelection.setScope(agentId);
      },
      refresh: () =>
        call(async (context) => {
          if ((await context.agents.refreshList()) === null) {
            throw new Error("The agent refresh did not complete. Try again.");
          }
        }),
    },
    dock: dock
      ? {
          openSession(params) {
            current().assistantDock.openSession(params, owner.abort);
            if (!dockCloseRetained) {
              dockCloseRetained = true;
              retain(() => dock.close(owner.abort));
            }
          },
          close() {
            current().assistantDock.close();
          },
          get openSessionKey() {
            return current().assistantDock.openSessionKey;
          },
        }
      : undefined,
    navigation: {
      openExternal(url) {
        current();
        openExternalUrlSafe(url);
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
        const context = current();
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
      registerTextReferenceProvider: (value) => runtime.register(owner, "textReferences", value),
      registerWidget: (value) => runtime.register(owner, "widgets", value),
      registerInlineView: (value) => {
        if (!isPluginInlineViewVersion(value.version)) {
          throw new Error("Inline view version must be an integer from 1 to 65535.");
        }
        return runtime.register(owner, "inlineViews", value, value.id + "@" + value.version);
      },
      registerReplacement: (value) => runtime.register(owner, "replacements", value),
      selectReplacement(surface, id) {
        current();
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
  return host;
}
