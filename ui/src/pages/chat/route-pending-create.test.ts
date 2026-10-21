// @vitest-environment jsdom
import { expect, it, onTestFinished } from "vitest";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  createSessionRouteContext,
  sessionRouteLocation,
} from "./route-resolution.test-support.ts";
import { pages } from "./route.ts";

it.each([
  { mainKey: "main", bridged: false },
  { mainKey: "workspace", bridged: false },
  { mainKey: "main", bridged: true },
  { mainKey: "workspace", bridged: true },
])(
  "opens an unadmitted agent's $mainKey chat synchronously without Gateway discovery (bridged: $bridged)",
  async ({ mainKey, bridged }) => {
    const { context, request, list } = createSessionRouteContext();
    context.agents.state.agentsList!.mainKey = mainKey;
    const agentId = "bot-30c3b5be-7f13-4057-866c-17b3c6d51896";
    const sessionKey = `agent:${agentId}:${mainKey}`;
    const creation = { sessionKey, admitted: false };
    const release = context.chatSubmissions.beginCreate({
      creation,
      message: null,
      displayName: "New agent",
      canDisplay: () => true,
    });
    onTestFinished(release);
    const location = sessionRouteLocation(
      sessionNavigationTarget({
        face: "chat",
        sessionKey,
        fallbackAgentId: agentId,
        mainKey,
        exactKey: true,
        preferenceDerivedFace: true,
      }),
    );
    if (bridged) {
      const search = new URLSearchParams(location.search);
      search.set(INTERNAL_SESSION_PATH_PARAM, location.pathname);
      location.pathname = "/chat";
      location.search = `?${search}`;
    }
    const route = pages[0];
    const loaded = route.loader!(context, {
      location,
      signal: new AbortController().signal,
      cause: "navigation",
      revalidating: false,
      shouldRun: () => true,
      deps: route.loaderDeps!(context, location),
    });

    expect(loaded).not.toBeInstanceOf(Promise);
    expect(await loaded).toMatchObject({ kind: "session", sessionKey, face: "chat", creation });
    expect(request).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  },
);

it.each(["admitted", "other-session"] as const)(
  "keeps Gateway resolution for a %s route",
  async (scenario) => {
    const { context, request } = createSessionRouteContext();
    const sessionKey = "agent:new-agent:main";
    onTestFinished(
      context.chatSubmissions.beginCreate({
        creation: { sessionKey, admitted: scenario === "admitted" },
        message: null,
        displayName: "New agent",
        canDisplay: () => true,
      }),
    );
    const targetAgentId = scenario === "admitted" ? "new-agent" : "roboclaw";
    const location = sessionRouteLocation(
      sessionNavigationTarget({
        face: "chat",
        sessionKey: `agent:${targetAgentId}:main`,
        fallbackAgentId: targetAgentId,
        exactKey: true,
        preferenceDerivedFace: true,
      }),
    );
    const route = pages[0];
    await route.loader!(context, {
      location,
      signal: new AbortController().signal,
      cause: "navigation",
      revalidating: false,
      shouldRun: () => true,
      deps: route.loaderDeps!(context, location),
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.resolve"]);
  },
);
