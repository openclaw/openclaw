import type { Plugin } from "vite";
import { CONTROL_UI_ROUTE_PRELOAD_ATTRIBUTE } from "../../src/gateway/control-ui-route-preloads.ts";
import { controlUiBootEntryRoute } from "./control-ui-chunking.ts";

export function controlUiBootPreloadsPlugin(): Plugin {
  return {
    name: "control-ui-boot-preloads",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const bundle = context.bundle;
        if (!bundle) {
          return html;
        }
        const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
        const initial = new Set<string>();
        const collect = (file: string, assets: Set<string>) => {
          if (assets.has(file)) {
            return;
          }
          assets.add(file);
          const chunk = bundle[file];
          if (chunk?.type !== "chunk") {
            return;
          }
          for (const dependency of chunk.imports) {
            collect(dependency, assets);
          }
          for (const css of chunk.viteMetadata?.importedCss ?? []) {
            assets.add(css);
          }
        };
        for (const chunk of chunks.filter((entry) => entry.isEntry)) {
          collect(chunk.fileName, initial);
        }
        const templates = (["chat", "new"] as const).map((route) => {
          const assets = new Set(initial);
          for (const chunk of chunks) {
            const owner = chunk.facadeModuleId
              ? controlUiBootEntryRoute(chunk.facadeModuleId)
              : undefined;
            if (owner === "shared" || owner === route) {
              collect(chunk.fileName, assets);
            }
          }
          const links = [...assets]
            .filter((file) => !initial.has(file))
            .map((file) => ({
              tag: "link",
              attrs: file.endsWith(".css")
                ? { rel: "preload", as: "style", crossorigin: "", href: `./${file}` }
                : { rel: "modulepreload", crossorigin: "", href: `./${file}` },
            }));
          return {
            tag: "template",
            attrs: { [CONTROL_UI_ROUTE_PRELOAD_ATTRIBUTE]: route },
            children: links,
            injectTo: "head" as const,
          };
        });
        // The Gateway activates only the requested route. CSS preloads fetch bytes
        // without changing the lazy stylesheet owner's cascade insertion order.
        return { html, tags: templates };
      },
    },
  };
}
