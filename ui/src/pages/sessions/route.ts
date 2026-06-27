import { html } from "lit";
import { definePage } from "../../router/index.ts";

export const page = definePage({
  id: "sessions",
  path: "/sessions",
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-sessions-page></openclaw-sessions-page>`,
    })),
});
