import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "safety",
  path: "/safety",
  component: () =>
    import("./safety-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-safety-page></openclaw-safety-page>`,
    })),
});
