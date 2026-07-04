import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "usage",
  path: "/usage",
  component: () =>
    import("./usage-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-usage-page></openclaw-usage-page>`,
    })),
});
