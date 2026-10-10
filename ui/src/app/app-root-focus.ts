import { buildControlUiFocusPath, type ControlUiFocusTarget } from "@openclaw/session-url-contract";
import type { RouteLocation, RouteNotFound } from "@openclaw/uirouter";
import { formatUiError } from "../lib/format-error.ts";
import type { ChatRouteData } from "../pages/chat/route-loader.ts";
import type { ApplicationContext } from "./context.ts";

export type FocusDashboardRouteState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ambiguous"; data: Extract<ChatRouteData, { kind: "ambiguous" }> }
  | { kind: "session"; data: Extract<ChatRouteData, { kind: "session" }> };

function isRouteNotFound(result: ChatRouteData | RouteNotFound): result is RouteNotFound {
  return "type" in result && result.type === "notFound";
}

/** Focus documents share the Chat loader and keep canonicalization inside their URL boundary. */
export async function loadFocusDashboard(
  context: ApplicationContext,
  target: Extract<ControlUiFocusTarget, { kind: "dashboard" }>,
  signal: AbortSignal,
): Promise<FocusDashboardRouteState> {
  const replaceLocation = (location: RouteLocation, source: RouteLocation) => {
    if (signal.aborted) {
      return;
    }
    const [expected, replacement] = [source, location].map((route) =>
      buildControlUiFocusPath(
        {
          kind: "dashboard",
          path: `${route.pathname}${route.search}${route.hash}`,
        },
        context.basePath,
      ),
    );
    const current = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
    if (expected && replacement && current === expected && replacement !== current) {
      globalThis.history.replaceState(globalThis.history.state, "", replacement);
    }
  };
  try {
    const { loadChatRoute } = await import("../pages/chat/route-loader.ts");
    const result = await loadChatRoute(context, target.route, "dashboard", signal);
    if (signal.aborted) {
      return { kind: "loading" };
    }
    if (isRouteNotFound(result) || result.kind === "missing-session") {
      return { kind: "not-found" };
    }
    if (result.kind === "route-error") {
      return { kind: "error", message: result.message };
    }
    if (result.kind === "ambiguous") {
      return {
        kind: "ambiguous",
        data: {
          ...result,
          candidates: result.candidates.map((candidate) => ({
            ...candidate,
            href:
              buildControlUiFocusPath(
                { kind: "dashboard", path: candidate.href },
                context.basePath,
              ) ?? candidate.href,
          })),
        },
      };
    }
    if (result.canonicalLocation && result.canonicalLocationSource) {
      replaceLocation(result.canonicalLocation, result.canonicalLocationSource);
    }
    const source = result.canonicalLocationSource;
    if (result.canonicalLocationReady && source) {
      void result.canonicalLocationReady.then((location) => {
        if (location) {
          replaceLocation(location, source);
        }
      });
    }
    return { kind: "session", data: result };
  } catch (error) {
    return { kind: "error", message: formatUiError(error) };
  }
}
