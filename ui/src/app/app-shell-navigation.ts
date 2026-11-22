import { isSettingsTakeover, type ShellNavigationIntent } from "../app-navigation.ts";
import {
  isSessionRouteId,
  pluginSlugCandidate,
  pluginTabSlugFromPath,
  sameRouteLocation,
} from "../app-route-paths.ts";
import { isRouteId, type RouteId } from "../app-routes.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { prepareSessionNavigationHandoff } from "../lib/sessions/navigation-handoff.ts";
import {
  findUiSessionRow,
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { settingsParentTarget } from "../lib/settings-navigation.ts";
import { canonicalModelSetupLocation } from "../pages/model-setup/route.ts";
import { newSessionSearch, type NewSessionTarget } from "../pages/new-session/location.ts";
import { selectApplicationSession } from "./agent-selection.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import { readDeletedSessionStartup } from "./deleted-session-startup.ts";
import { isMobileNavLayout } from "./mobile-nav-layout.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";
import {
  isNativeEmbedHost,
  isNativeMobileHost,
  isNativeWebChromeHost,
} from "./native-web-chrome.ts";
import type { NavDrawerCloseOptions } from "./navigation-surface.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";

export interface ShellNavigationHost {
  readonly context: ApplicationContext | undefined;
  activeSessionKey: string;
  routeState: ShellRouteState;
  lastWorkspaceLocation: ({ routeId: RouteId } & Required<ApplicationNavigationOptions>) | null;
  custodianMinimizeRequestId: number;
  /** This page showed first-use setup; its automatic panels and promotions stay quiet. */
  firstUse: boolean;
  lastConcreteRouteId: RouteId | undefined;
  didConsiderNativeRouteRestore: boolean;
  settingsSearchQuery: string;
  closeNavDrawer(options?: NavDrawerCloseOptions): void;
  ensureAgentsList(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    agents?: ApplicationContext["agents"],
  ): void;
}

export class ShellNavigationOwner {
  constructor(private readonly host: ShellNavigationHost) {}

  selectChatSession(sessionKey: string, agentId?: string | null): void {
    const context = this.host.context;
    if (!context) {
      return;
    }
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId,
    });
    const face = resolveSessionPreferredFaceForKey(context, sessionKey, agentId);
    this.navigate(
      face,
      sessionNavigationTarget({
        context,
        face,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        preferenceDerivedFace: true,
      }).options,
    );
  }

  chatNavigationOptions(face: BoardFace, options?: ApplicationNavigationOptions) {
    const sessionKey = this.host.activeSessionKey.trim();
    const context = this.host.context;
    return (
      options ??
      (sessionKey && context
        ? sessionNavigationTarget({ context, face, sessionKey }).options
        : undefined)
    );
  }

  readonly navigate = (
    routeId: string,
    options?: ApplicationNavigationOptions,
    intent?: ShellNavigationIntent,
  ): void => {
    const context = this.host.context;
    if (!context || !isRouteId(routeId)) {
      return;
    }
    // On mobile web, entering a section reveals its list in the open drawer.
    // Selecting a destination from that list still gets the usual dismissal.
    if (
      intent !== "sidebar-section" ||
      !isMobileNavLayout() ||
      isNativeWebChromeHost() ||
      isNativeMobileHost() ||
      isNativeEmbedHost()
    ) {
      // The new draft owns focus after it mounts; a drawer return must not reclaim it.
      this.host.closeNavDrawer({ restoreFocus: routeId !== "new-session", finishMotion: true });
    }
    context.navigate(
      routeId,
      isSessionRouteId(routeId) ? this.chatNavigationOptions(routeId, options) : options,
    );
  };

  recoverNotFoundRoute(): boolean {
    const context = this.host.context;
    const location = this.host.routeState.location ?? window.location;
    if (context && pluginSlugCandidate(location.pathname, context.basePath)) {
      if (context.gateway.snapshot.phase !== "connected") {
        return false;
      }
      if (pluginTabSlugFromPath(location.pathname, context.basePath)) {
        context.replace("plugin", {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        });
        return true;
      }
    }
    // A failed session can recover its active identity; an unknown URL cannot
    // establish that intent and must retain its not-found destination.
    return isSessionRouteId(this.host.routeState.routeId)
      ? this.replaceChatWithCurrentSession()
      : true;
  }

  replaceChatWithCurrentSession(): boolean {
    const context = this.host.context;
    const sessionKey = this.host.activeSessionKey.trim();
    if (!context) {
      return true;
    }
    if (!parseAgentSessionKey(sessionKey) && context.gateway.snapshot.phase !== "connected") {
      return false;
    }
    const face = this.host.routeState.routeId === "dashboard" ? "dashboard" : "chat";
    if (face === "chat" && readDeletedSessionStartup(context, sessionKey)) {
      return true;
    }
    const sessionWasDeleted = context.sessions.deletionState(sessionKey);
    // Session lists are filtered and windowed. Only a failed route for this
    // active key, or an authoritative deletion, proves it needs replacement.
    const activeSessionRow = findUiSessionRow(context, sessionKey);
    const attemptedPathname = this.host.routeState.location?.pathname;
    const activeRouteFailed =
      !attemptedPathname ||
      attemptedPathname === sessionNavigationTarget({ context, face, sessionKey }).options.pathname;
    const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    const knownAgents = context.agents.state.agentsList?.agents;
    // A parseable retired agent is not a navigable owner; never turn its
    // deleted session into another permanently unresolvable chat route.
    const replacementAgentId =
      parsedAgentId &&
      (!knownAgents || knownAgents.some((agent) => normalizeAgentId(agent.id) === parsedAgentId))
        ? parsedAgentId
        : resolveSessionNavigationAgentId(context);
    const replacementSessionKey =
      !sessionWasDeleted && (activeSessionRow?.key || !activeRouteFailed)
        ? sessionKey
        : buildAgentMainSessionKey({
            agentId: replacementAgentId,
            mainKey: resolveUiConfiguredMainKey({
              agentsList: context.agents.state.agentsList,
              hello: context.gateway.snapshot.hello,
            }),
          });
    // Gateway rejects deletion of a live main session. If an orphaned event
    // still names that fallback, replacing the same route would retry forever.
    if (sessionWasDeleted && replacementSessionKey === sessionKey) {
      return true;
    }
    if (replacementSessionKey !== sessionKey) {
      // Commit the replacement to both selection owners before navigating;
      // otherwise a stale Gateway snapshot restores the deleted key and loops.
      this.host.activeSessionKey = replacementSessionKey;
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey: replacementSessionKey,
      });
    }
    context.replace(
      face,
      sessionNavigationTarget({ context, face, sessionKey: replacementSessionKey }).options,
    );
    return true;
  }

  recoverDeletedActiveSession(): void {
    const context = this.host.context;
    const routeId = this.host.routeState.routeId;
    const sessionKey = this.host.activeSessionKey.trim();
    if (!context || !routeId || !isSessionRouteId(routeId) || !sessionKey) {
      return;
    }
    const selectedSessionDeleted = context.sessions.deletionState(sessionKey);
    if (selectedSessionDeleted) {
      this.replaceChatWithCurrentSession();
    }
  }

  synchronizeSessionUrl(): void {
    const context = this.host.context;
    const { routeId, location, committedRouteId, committedLocation, committedSessionKey } =
      this.host.routeState;
    if (
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      this.host.routeState.sessionUrlPending ||
      !isSessionRouteId(committedRouteId) ||
      routeId !== committedRouteId ||
      !committedLocation ||
      !committedSessionKey ||
      !sameRouteLocation(location, committedLocation) ||
      !sameRouteLocation(window.location, committedLocation)
    ) {
      return;
    }
    const target = sessionRefFromPath(committedLocation.pathname, context.basePath);
    // The settled route owns identity; use the same live name projection as the tab title.
    const row = context.sessions.presentation.result?.sessions.find(
      (candidate) => candidate.key === committedSessionKey,
    );
    if (target?.kind !== "short" || !row?.displayName?.trim()) {
      return;
    }
    const pathname = pathForSession(committedRouteId, target.agentId, row.key, context.basePath, {
      displayName: row.displayName,
      shortIdLength: target.shortId.length,
    });
    if (!pathname || pathname === committedLocation.pathname) {
      return;
    }
    // Rename only the settled route; pending navigation owns the address bar.
    // Carry its resolved identity so a title change needs no discovery request.
    prepareSessionNavigationHandoff(context.gateway, pathname, row.key);
    context.replace(committedRouteId, { ...committedLocation, pathname });
  }

  updateRouteState(routeState: ShellRouteState): void {
    this.host.routeState = routeState;
    if (routeState.routeId !== undefined) {
      if (this.host.lastConcreteRouteId === "custodian" && routeState.routeId !== "custodian") {
        this.host.custodianMinimizeRequestId += 1;
      }
      this.host.lastConcreteRouteId = routeState.routeId;
    }
    const location = routeState.location;
    if (
      location &&
      (routeState.routeId === "custodian"
        ? resolveOnboardingMode(location.search)
        : routeState.routeId === "model-setup" &&
          canonicalModelSetupLocation(location, this.host.context?.basePath ?? "") === location)
    ) {
      this.host.firstUse = true;
    }
    const committedRouteId = routeState.committedRouteId;
    const committedPathname = routeState.committedLocation?.pathname ?? "";
    const committedSearch = routeState.committedLocation?.search ?? "";
    // Restoration and persistence both wait for a live context: consuming the
    // one-shot restore without a router to call, or persisting the bootstrap
    // route first, would clobber the stored route.
    const routeContext = this.host.context;
    if (committedRouteId && routeContext) {
      // A rendered/pending match that differs from the committed route is an
      // in-flight navigation: it wins over the one-shot restore, and the stale
      // committed route must not be persisted over the remembered destination.
      const pendingDiffers =
        routeContext.chatSubmissions.creation ||
        routeState.routeId !== committedRouteId ||
        (routeState.location?.pathname ?? "") !== committedPathname ||
        (routeState.location?.search ?? "") !== committedSearch;
      if (!this.host.didConsiderNativeRouteRestore) {
        this.host.didConsiderNativeRouteRestore = true;
        const storedRoute = pendingDiffers
          ? null
          : considerRouteRestore(committedRouteId, committedPathname, committedSearch);
        if (storedRoute) {
          // Replace instead of push so a fresh window does not start with a
          // Back entry pointing at the bootstrap chat route.
          routeContext.replace(storedRoute.routeId, {
            pathname: storedRoute.pathname,
            search: storedRoute.search,
          });
          return;
        }
      }
      if (!pendingDiffers) {
        const committedSessionKey = routeState.committedSessionKey;
        const committedSessionDeleted =
          committedSessionKey !== undefined &&
          routeContext.sessions.deletionState(committedSessionKey);
        if (committedSessionDeleted) {
          if (
            committedRouteId === "chat" &&
            readDeletedSessionStartup(routeContext, committedSessionKey)
          ) {
            return;
          }
          // An older route can commit after deletion recovery has started.
          // Never let it persist or reselect the session we just retired.
          this.replaceChatWithCurrentSession();
          return;
        }
        persistRoute(committedRouteId, committedPathname, committedSearch);
        if (committedSessionKey) {
          this.host.activeSessionKey = committedSessionKey;
          selectApplicationSession({
            selection: routeContext.agentSelection,
            gateway: routeContext.gateway,
            sessionKey: committedSessionKey,
            background: true,
          });
        }
      }
    }
    const context = this.host.context;
    if (context) {
      this.host.ensureAgentsList(context.gateway.snapshot);
    }
    this.synchronizeSessionUrl();
    if (
      routeState.routeId &&
      !isSettingsTakeover(
        routeState.routeId,
        context?.gateway.snapshot.hello?.controlUiTabs,
        routeState.location,
        context?.basePath,
      )
    ) {
      // The embedded list is this search's home, so its results survive Back.
      if (routeState.routeId !== "settings") {
        this.host.settingsSearchQuery = "";
      }
      this.host.lastWorkspaceLocation = {
        routeId: routeState.routeId,
        pathname: routeState.location?.pathname ?? "",
        search: routeState.location?.search ?? "",
        hash: routeState.location?.hash ?? "",
      };
    }
  }

  newSessionRouteAgentId(): string {
    if (this.host.routeState.routeId !== "new-session") {
      return "";
    }
    return (
      new URLSearchParams(this.host.routeState.location?.search ?? "").get("agent")?.trim() ?? ""
    );
  }

  openNewSession(agentId: string, target?: NewSessionTarget): void {
    this.navigate("new-session", { search: newSessionSearch(agentId, target) });
  }

  /** Escape: one level up from a subpage, out of Settings from a top-level section. */
  leaveSettingsLevel(): void {
    const { routeId, location } = this.host.routeState;
    const basePath = this.host.context?.basePath ?? "";
    const parent =
      routeId && isRouteId(routeId) ? settingsParentTarget(routeId, location, basePath) : null;
    if (parent) {
      const { routeId: parentRoute, ...parentLocation } = parent;
      this.navigate(parentRoute, parentLocation);
      return;
    }
    this.exitSettings();
  }

  exitSettings(): void {
    const previous = this.host.lastWorkspaceLocation;
    if (previous) {
      const { routeId, ...location } = previous;
      this.navigate(routeId, location);
      return;
    }
    this.navigate("chat");
  }
}

export type ShellNavigationCapability = Pick<ShellNavigationOwner, keyof ShellNavigationOwner>;
