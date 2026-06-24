import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveAgentIdFromSessionKey } from "../../lib/session-key.ts";
import type { RouteLocation } from "../../router/index.ts";
import { definePage } from "../../router/index.ts";

function sessionKeyFromLocation(location: RouteLocation): string | undefined {
  const sessionKey = new URLSearchParams(location.search).get("session")?.trim();
  return sessionKey || undefined;
}

function draftFromLocation(location: RouteLocation): string | undefined {
  const draft = new URLSearchParams(location.search).get("draft");
  return draft || undefined;
}

export const page = definePage({
  id: "chat",
  path: "/chat",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${sessionKeyFromLocation(location) ?? ""}\u0000${draftFromLocation(location) ?? ""}`,
  loader: async (context: ApplicationContext, { location }) => {
    const sessionKey = sessionKeyFromLocation(location) ?? context.gateway.snapshot.sessionKey;
    return {
      sessionKey,
      draft: draftFromLocation(location),
      headerContext: {
        agentLabel: resolveAgentIdFromSessionKey(sessionKey),
      },
    };
  },
  component: () =>
    import("./page.ts").then(() => ({
      header: true,
      render: (data: unknown) => html`<openclaw-chat-page .data=${data}></openclaw-chat-page>`,
    })),
});
