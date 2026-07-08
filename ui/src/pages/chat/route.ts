import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, notFound } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";

function sessionKeyFromLocation(location: RouteLocation): string | undefined {
  const sessionKey = new URLSearchParams(location.search).get("session")?.trim();
  return sessionKey || undefined;
}

function draftFromLocation(location: RouteLocation): string | undefined {
  const draft = new URLSearchParams(location.search).get("draft");
  return draft || undefined;
}

function focusComposerFromLocation(location: RouteLocation): boolean {
  return new URLSearchParams(location.search).get("focusComposer") === "1";
}

export const page = definePage({
  id: "chat",
  path: "/chat",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    [
      sessionKeyFromLocation(location) ?? "",
      draftFromLocation(location) ?? "",
      focusComposerFromLocation(location) ? "focus" : "",
    ].join("\u0000"),
  loader: async (_context: ApplicationContext, { location }) => {
    const sessionKey = sessionKeyFromLocation(location);
    if (!sessionKey) {
      return notFound({ routeId: "chat" });
    }
    return {
      sessionKey,
      draft: draftFromLocation(location),
      focusComposer: focusComposerFromLocation(location),
    };
  },
  component: () =>
    import("./chat-page.ts").then(() => ({
      header: true,
      render: (data: unknown) => html`<openclaw-chat-page .data=${data}></openclaw-chat-page>`,
    })),
});
