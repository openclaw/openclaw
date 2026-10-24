import type { IndexHtmlTransformContext, Plugin } from "vite";
import { CONTROL_UI_ROUTE_PRELOAD_ATTRIBUTE } from "../../src/gateway/control-ui-route-preloads.ts";
import { controlUiBootEntryRoute, controlUiBootManifestKey } from "./control-ui-chunking.ts";

/** One dependency walk serves both route hints and the offline shell's critical assets. */
export function collectControlUiBootAssets(
  bundle: NonNullable<IndexHtmlTransformContext["bundle"]>,
) {
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
    for (const asset of chunk.viteMetadata?.importedAssets ?? []) {
      assets.add(asset);
    }
  };
  for (const chunk of chunks.filter((entry) => entry.isEntry)) {
    collect(chunk.fileName, initial);
  }
  const routes = { chat: new Set(initial), new: new Set(initial) };
  const login = new Set(initial);
  for (const chunk of chunks) {
    // Optimized dynamic imports can live inside a shared chunk without a facade.
    const entries = chunk.facadeModuleId ? [chunk.facadeModuleId] : Object.keys(chunk.modules);
    // Forgetting local sign-in or rejecting cached admission must show the real
    // gate offline, not fail while downloading its optional component.
    if (
      entries.some(
        (id) => controlUiBootManifestKey(id) === "ui/src/components/login-gate-solid.tsx",
      )
    ) {
      collect(chunk.fileName, login);
    }
    for (const route of ["chat", "new"] as const) {
      if (
        entries.some((id) => {
          const owner = controlUiBootEntryRoute(id);
          return owner === "shared" || owner === route;
        })
      ) {
        collect(chunk.fileName, routes[route]);
      }
    }
  }
  // Grouping can emit dynamic re-export facades that the ungrouped capture did
  // not need. They introduce no code beyond the measured graph, but a warm
  // import still requests their URL (for example, a sidebar controller).
  for (const assets of [...Object.values(routes), login]) {
    let added;
    do {
      added = false;
      for (const chunk of chunks) {
        if (
          !assets.has(chunk.fileName) &&
          chunk.isDynamicEntry &&
          chunk.moduleIds.length === 0 &&
          chunk.imports.length > 0 &&
          chunk.imports.every((file) => assets.has(file))
        ) {
          collect(chunk.fileName, assets);
          added = true;
        }
      }
    } while (added);
  }
  return { initial, ...routes, login };
}

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
        const assets = collectControlUiBootAssets(bundle);
        const templates = (["chat", "new"] as const).map((route) => {
          const links = [...assets[route]]
            // URL assets such as attachment workers belong to the offline cache,
            // but are not modules in the document's boot graph.
            .filter(
              (file) =>
                !assets.initial.has(file) &&
                (bundle[file]?.type === "chunk" || file.endsWith(".css")),
            )
            .map((file) => ({
              tag: "link",
              attrs: file.endsWith(".css")
                ? { rel: "preload", as: "style", crossorigin: "", href: `./${file}` }
                : {
                    rel: "modulepreload",
                    crossorigin: "",
                    // Keep signing and the composer ahead of other Chat content.
                    ...(route === "chat" &&
                    bundle[file]?.type === "chunk" &&
                    bundle[file].name.startsWith("control-ui-boot-chat") &&
                    Object.keys(bundle[file].modules).every(
                      (id) =>
                        controlUiBootManifestKey(id) !==
                        "ui/src/pages/chat/components/chat-composer.tsx",
                    )
                      ? { fetchpriority: "low" }
                      : {}),
                    href: `./${file}`,
                  },
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
