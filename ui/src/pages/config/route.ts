import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { ConfigPageId } from "./config-page.ts";

async function loadConfigRoute(context: ApplicationContext) {
  const primaryRefresh = context.runtimeConfig.refresh();
  void primaryRefresh.then(
    () => {
      void context.runtimeConfig.refreshSchema();
    },
    () => undefined,
  );
  await primaryRefresh;
}

function configPage(id: ConfigPageId, path: string) {
  return definePage({
    id,
    path,
    loader: (context: ApplicationContext) => loadConfigRoute(context),
    component: () =>
      import("./config-page.ts").then(() => ({
        header: true,
        render: () => html`<openclaw-config-page .pageId=${id}></openclaw-config-page>`,
      })),
  });
}

export const pages = [
  configPage("config", "/config"),
  configPage("communications", "/communications"),
  configPage("appearance", "/appearance"),
  configPage("automation", "/automation"),
  configPage("mcp", "/mcp"),
  configPage("infrastructure", "/infrastructure"),
  configPage("ai-agents", "/ai-agents"),
] as const;
