import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "custodian",
  path: "/custodian",
  component: () =>
    import("./custodian-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-custodian-page></openclaw-custodian-page>`,
    })),
});
