import type { RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_SESSION_PATH_PARAM } from "../app-route-paths.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { sessionRefFromPath, type SessionPathTarget } from "../app-session-route-paths.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../lib/sessions/catalog-key.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
} from "../lib/sessions/session-key.ts";
import type { ApplicationContext } from "./context.ts";
import { releasedSessionQuery, resolvePersistedAgentId } from "./released-session-query.ts";

export function initialSessionIdentity(
  location: Pick<RouteLocation, "pathname" | "search">,
  context: Pick<ApplicationContext, "basePath" | "theme" | "agents" | "gateway" | "agentSelection">,
  fallbackSessionKey = "",
): ReturnType<typeof resolveUiConversationIdentity> {
  const { basePath } = context;
  const settings = context.theme.settings;
  const defaults = {
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  };
  const mainKey = resolveUiConfiguredMainKey(defaults);
  const catalog = catalogSessionKeyFromSearch(location.search);
  const identityForRef = (
    ref: Exclude<SessionPathTarget, { kind: "short" }>,
    agentId = ref.agentId,
  ) =>
    resolveUiConversationIdentity(
      defaults,
      ref.kind === "main"
        ? catalog
          ? buildCatalogSessionKey(catalog, ref.agentId)
          : buildAgentMainSessionKey({ agentId: ref.agentId, mainKey })
        : ref.sessionKey,
      agentId,
    );
  const released = releasedSessionQuery(location, basePath);
  if (released?.sessionKey) {
    const agentId =
      parseAgentSessionKey(released.sessionKey)?.agentId ??
      (resolvePersistedAgentId(context.agentSelection.state.selectedId, defaults.agentsList) ||
        resolveUiDefaultAgentId(defaults));
    const pathname = pathForSession(released.face, agentId, released.sessionKey, basePath, {
      mainKey,
    });
    const target = pathname ? sessionRefFromPath(pathname, basePath, mainKey) : null;
    return target && target.kind !== "short"
      ? identityForRef(target, agentId)
      : resolveUiConversationIdentity(defaults, released.sessionKey, agentId);
  }
  const ref =
    sessionRefFromPath(location.pathname, basePath, mainKey) ??
    sessionRefFromPath(
      new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM) ?? "",
      basePath,
      mainKey,
    );
  if (!ref) {
    return { sessionKey: fallbackSessionKey };
  }
  if (ref.kind !== "short") {
    return identityForRef(ref);
  }
  // A saved selection belongs to this URL only when its canonical short id matches.
  const known = new Set(
    [
      settings.sessionKey,
      ...Object.keys(settings.sidebarSessionLayouts ?? {}),
      ...(settings.chatSplitLayout?.columns.flatMap((column) =>
        column.panes.map((pane) => pane.sessionKey),
      ) ?? []),
    ].map((key) => resolveUiConversationIdentity(defaults, key).sessionKey),
  );
  const matches = [...known].filter((key) => {
    const path = pathForSession(ref.namespace, ref.agentId, key, basePath, {
      mainKey,
      shortIdLength: ref.shortId.length,
    });
    const candidate = path ? sessionRefFromPath(path, basePath, mainKey) : null;
    return (
      candidate?.kind === "short" &&
      candidate.agentId === ref.agentId &&
      candidate.shortId === ref.shortId
    );
  });
  return matches.length === 1
    ? resolveUiConversationIdentity(defaults, matches[0]!, ref.agentId)
    : { sessionKey: "", agentId: ref.agentId };
}
