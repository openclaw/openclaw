import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("memory-import"),
  component: () =>
    import("./memory-import-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.MemoryImportPage, {}),
    })),
});
