import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionsRouteData } from "./sessions-page.ts";

async function loadSessionsRoute(context: ApplicationContext): Promise<SessionsRouteData> {
  const [sessions] = await Promise.all([
    context.sessions
      .list({
        activeMinutes: 60,
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        showArchived: false,
      })
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error: String(error) }),
      ),
    context.runtimeConfig.ensureLoaded().catch(() => undefined),
  ]);
  const gateway = context.gateway.snapshot;
  return {
    client: gateway.client,
    connected: gateway.connected,
    result: sessions.result,
    error: sessions.error,
  };
}

export const page = definePage({
  id: "sessions",
  path: "/sessions",
  loader: loadSessionsRoute,
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: (data: SessionsRouteData | undefined) =>
        html`<openclaw-sessions-page .routeData=${data}></openclaw-sessions-page>`,
    })),
});
