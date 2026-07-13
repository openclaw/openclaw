import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";

async function loadWorkboardRoute(context: ApplicationContext) {
  const sessions = context.sessions.state;
  await Promise.all([
    context.runtimeConfig.ensureLoaded(),
    context.agents.ensureList(),
    sessions.result || sessions.loading ? Promise.resolve() : context.sessions.refresh(),
  ]);
}

export const page = definePage({
  id: "workboard",
  path: "/workboard",
  loader: loadWorkboardRoute,
  component: () =>
    import("./workboard-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-workboard-page></openclaw-workboard-page>`,
    })),
});
