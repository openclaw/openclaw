import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

/** Reads the plugin tab id from a `/plugin?id=<tab>` location search string. */
export function pluginTabIdFromSearch(search: string): string {
  return new URLSearchParams(search).get("id")?.trim() ?? "";
}

// One static route hosts every plugin-declared tab; the router only supports
// exact paths, so the tab id travels in the query string like chat sessions.
export const page = definePage({
  id: "plugin",
  path: "/plugin",
  loaderDeps: (_context, location) => location.search,
  loader: (_context, options) => pluginTabIdFromSearch(options.location.search),
  component: () =>
    import("./plugin-page.ts").then(() => ({
      header: true,
      render: (data: unknown) =>
        html`<openclaw-plugin-page .tabId=${typeof data === "string" ? data : ""}>
        </openclaw-plugin-page>`,
    })),
});
