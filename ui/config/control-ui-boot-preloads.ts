import type { IndexHtmlTransformContext, Plugin } from "vite";
import { CONTROL_UI_ROUTE_PRELOAD_ATTRIBUTE } from "../../src/gateway/control-ui-route-preloads.ts";
import { controlUiBootEntryRoute, controlUiBootManifestKey } from "./control-ui-chunking.ts";

// These common interactions download beside the route, but evaluate only on use.
// Include the nested option entries too: opening a menu must not start a second RTT.
const sharedInteractionEntries = new Set([
  "ui/src/pages/chat/components/chat-composer-mention-menu-engine.ts",
  "ui/src/pages/chat/components/chat-composer-emoji-engine.ts",
  "ui/src/pages/chat/components/chat-composer-slash-menu.tsx",
  "ui/src/pages/chat/components/chat-composer-slash-menu-options.tsx",
  "ui/src/pages/chat/components/chat-composer-skill-menu.tsx",
  "ui/src/pages/chat/components/chat-composer-skill-menu-options.tsx",
  "ui/src/pages/chat/components/chat-composer-mention-menu.tsx",
  "ui/src/pages/chat/components/chat-composer-mention-menu-options.tsx",
  "ui/src/pages/chat/components/chat-composer-emoji.tsx",
  "ui/src/pages/chat/components/chat-composer-emoji-options.tsx",
  "ui/src/components/app-sidebar-online.tsx",
]);
const chatInteractionEntries = new Set([
  "ui/src/pages/chat/chat-composer-capability-host.tsx",
  "ui/src/pages/chat/components/chat-context-breakdown.tsx",
  "ui/src/components/markdown-live.ts",
  // Cached environment facts reveal without another network round trip.
  "ui/src/pages/chat/components/chat-details-environment-body.tsx",
  "ui/src/pages/chat/chat-pane-session-operations.ts",
  "ui/src/pages/chat/chat-send-delivery.runtime.ts",
  // Keep the first live reply and common actions to one network round trip.
  "ui/src/pages/chat/chat-live-events.runtime.ts",
  "ui/src/pages/chat/tool-stream.ts",
  "ui/src/pages/chat/chat-command-dispatch.runtime.ts",
  "ui/src/pages/chat/chat-pane-session-operations.runtime.ts",
  // Image viewers and provider-review dialogs load only when their own UI is needed.
]);

export function collectControlUiStaticAssets(
  bundle: NonNullable<IndexHtmlTransformContext["bundle"]>,
  file: string,
  assets: Set<string>,
): void {
  if (assets.has(file)) {
    return;
  }
  assets.add(file);
  const chunk = bundle[file];
  if (chunk?.type !== "chunk") {
    return;
  }
  for (const dependency of chunk.imports) {
    collectControlUiStaticAssets(bundle, dependency, assets);
  }
  for (const asset of [
    ...(chunk.viteMetadata?.importedCss ?? []),
    ...(chunk.viteMetadata?.importedAssets ?? []),
  ]) {
    assets.add(asset);
  }
}

/** One dependency walk serves both route hints and the offline shell's critical assets. */
export function collectControlUiBootAssets(
  bundle: NonNullable<IndexHtmlTransformContext["bundle"]>,
) {
  const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
  const initial = new Set<string>();
  for (const chunk of chunks.filter((entry) => entry.isEntry)) {
    collectControlUiStaticAssets(bundle, chunk.fileName, initial);
  }
  const routes = { chat: new Set(initial), new: new Set(initial) };
  const interactions = { chat: new Set<string>(), new: new Set<string>() };
  const login = new Set(initial);
  // Browser admission signs before the shell can become interactive. Download
  // the signer first without evaluating it or requesting its dynamic fallback.
  for (const chunk of chunks) {
    if (
      Object.keys(chunk.modules).some(
        (id) => controlUiBootManifestKey(id) === "ui/src/lib/nodes/device-signing.runtime.ts",
      )
    ) {
      for (const assets of Object.values(routes)) {
        collectControlUiStaticAssets(bundle, chunk.fileName, assets);
      }
    }
  }
  for (const [route, entry] of [
    ["chat", "ui/src/pages/chat/route-entry.ts"],
    ["new", "ui/src/pages/new-session/new-session-page-entry.ts"],
  ] as const) {
    const chunk = chunks.find((candidate) =>
      [candidate.facadeModuleId, ...Object.keys(candidate.modules)].some(
        (id) => id && controlUiBootManifestKey(id) === entry,
      ),
    );
    if (chunk) {
      collectControlUiStaticAssets(bundle, chunk.fileName, routes[route]);
    }
  }
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
      collectControlUiStaticAssets(bundle, chunk.fileName, login);
    }
    for (const route of ["chat", "new"] as const) {
      if (
        entries.some((id) => {
          const key = controlUiBootManifestKey(id);
          // Placement belongs to the first New Session action, never Chat boot.
          if (key === "ui/src/app/session-placement-startup.runtime.ts") {
            return route === "new";
          }
          const owner = controlUiBootEntryRoute(id);
          return owner === "shared" || owner === route;
        })
      ) {
        collectControlUiStaticAssets(bundle, chunk.fileName, routes[route]);
      }
      if (
        entries.some((id) => {
          const key = controlUiBootManifestKey(id);
          return (
            sharedInteractionEntries.has(key) ||
            (route === "chat" && chatInteractionEntries.has(key))
          );
        })
      ) {
        collectControlUiStaticAssets(bundle, chunk.fileName, interactions[route]);
      }
    }
  }
  // Grouping can emit dynamic re-export facades that the ungrouped capture did
  // not need. They introduce no code beyond the measured graph, but a warm
  // import still requests their URL (for example, a sidebar controller).
  for (const assets of [...Object.values(routes), ...Object.values(interactions), login]) {
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
          collectControlUiStaticAssets(bundle, chunk.fileName, assets);
          added = true;
        }
      }
    } while (added);
  }
  const interactionOnly = { chat: new Set<string>(), new: new Set<string>() };
  for (const route of ["chat", "new"] as const) {
    for (const file of interactions[route]) {
      if (!routes[route].has(file)) {
        interactionOnly[route].add(file);
        routes[route].add(file);
      }
    }
  }
  return { initial, ...routes, login, interactionOnly };
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
        const importedStyles = new Set<string>();
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            for (const file of output.viteMetadata?.importedCss ?? []) {
              importedStyles.add(file);
            }
          }
        }
        const templates = (["chat", "new"] as const).map((route) => {
          const links = [...assets[route]]
            // URL assets such as attachment workers belong to the offline cache,
            // but are not modules in the document's boot graph.
            .filter(
              (file) =>
                !assets.initial.has(file) &&
                (bundle[file]?.type === "chunk" || importedStyles.has(file)),
            )
            .map((file) => ({
              tag: "link",
              attrs: file.endsWith(".css")
                ? {
                    rel: "preload",
                    as: "style",
                    crossorigin: "",
                    ...(assets.interactionOnly[route].has(file) ? { fetchpriority: "low" } : {}),
                    href: `./${file}`,
                  }
                : {
                    ...(assets.interactionOnly[route].has(file)
                      ? { rel: "preload", as: "script", fetchpriority: "low" }
                      : { rel: "modulepreload" }),
                    crossorigin: "",
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
