import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("skill-workshop"),
  component: () =>
    import("./skill-workshop-page.ts").then(() => ({
      render: () => html`<openclaw-skill-workshop-page></openclaw-skill-workshop-page>`,
    })),
});
