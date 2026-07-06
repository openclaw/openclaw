import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "debug",
  path: "/settings/debug",
  aliases: ["/debug"],
  component: () =>
    import("./debug-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-debug-page></openclaw-debug-page>`,
    })),
});
