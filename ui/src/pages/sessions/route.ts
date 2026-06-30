import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "sessions",
  path: "/sessions",
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-sessions-page></openclaw-sessions-page>`,
    })),
});
