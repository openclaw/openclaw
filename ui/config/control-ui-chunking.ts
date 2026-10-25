// Control UI config module wires control ui chunking behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type ResolvedConfig } from "vite";
import {
  resolvedLocaleConfigHintsModulePrefix,
  resolvedLocaleNamespaceModulePrefix,
} from "./control-ui-locales.ts";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");
// Fresh /new and /chat captures separate shared boot work from route-only work.
// The generator disables these groups so stale entries cannot feed back into it.
const controlUiBootModules = JSON.parse(
  fs.readFileSync(path.join(configDir, "control-ui-boot-modules.json"), "utf8"),
) as Record<"shared" | "new" | "chat", string[]> & {
  entries: Record<"shared" | "new" | "chat", string[]>;
};

const bootEntryRoutes = new Map(
  (["shared", "new", "chat"] as const).flatMap((route) =>
    controlUiBootModules.entries[route].map((id) => [id, route] as const),
  ),
);

export function controlUiBootEntryRoute(id: string) {
  return bootEntryRoutes.get(controlUiBootManifestKey(id));
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

export function controlUiBootManifestKey(id: string): string {
  // Canonical manifest key: vendor modules key from their innermost
  // node_modules entry so pnpm virtual-store paths match; first-party modules
  // key repo-relative.
  const stripped = id.replace(/[?#].*$/u, "");
  const normalized = normalizeModuleId(stripped);
  const vendorIndex = normalized.lastIndexOf("/node_modules/");
  if (vendorIndex !== -1) {
    return `node_modules/${normalized.slice(vendorIndex + "/node_modules/".length)}`;
  }
  return normalizeModuleId(path.relative(repoRoot, stripped));
}

function moduleIdIncludesPackage(id: string, packageName: string): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.includes(`/openclaw-pnpm-node-modules/${packageName}/`)
  );
}

export const controlUiLocaleConfigHintsChunkPrefix = "locale-config-hints-";

export function controlUiStableChunkName(id: string): string | undefined {
  const normalized = normalizeModuleId(id);

  switch (controlUiBootManifestKey(id)) {
    case "node_modules/@solidjs/signals/dist/prod/deferred.js":
      // Route readers share this hook below without adding it to eager Solid code.
      return undefined;
    case "ui/src/lib/nodes/device-signing.runtime.ts":
      return "device-signing-runtime";
    case "ui/src/lib/device-pair-setup.ts":
      // Pairing loads on interaction; the earlier boot capture must not pull it into either route.
      return "device-pair-setup-runtime";
    case "ui/src/pages/chat/chat-send-delivery.runtime.ts":
    case "ui/src/pages/chat/chat-send-queue-runtime.ts":
      return "chat-delivery-runtime";
    case "ui/src/lib/sessions/session-mutation-operations.runtime.ts":
    case "ui/src/lib/sessions/session-mutation-refresh.ts":
    case "ui/src/lib/sessions/create.ts":
    case "ui/src/lib/sessions/session-patch-row-facts.ts":
    case "src/shared/session-unread.ts":
    case "ui/src/lib/sessions/session-delete-operation.ts":
      // Session actions must not import whole route chunks through earlier boot captures.
      return "session-mutation-runtime";
    case "ui/src/lib/chat/emoji.ts":
    case "node_modules/markdown-it-emoji/lib/data/full.mjs":
      // Shortcode input owns the catalog; earlier boot captures must not keep it eager.
      return "emoji-runtime";
    case "ui/src/components/mascot-animator.ts":
      // Only visible mascots request motion; stale boot captures must not keep it eager.
      return "mascot-motion-runtime";
    case "ui/src/components/emoji-search-panel.tsx":
    case "ui/src/styles/emoji-search-panel.css":
      return "emoji-search-panel";
    case "ui/src/pages/chat/components/chat-composer-emoji-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-emoji.tsx":
    case "ui/src/pages/chat/components/chat-composer-mention-menu-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-mention-menu.tsx":
    case "ui/src/pages/chat/components/chat-composer-menu.tsx":
    case "ui/src/pages/chat/components/chat-composer-skill-menu-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-skill-menu.tsx":
    case "ui/src/pages/chat/components/chat-composer-slash-menu-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-slash-menu-dom.tsx":
    case "ui/src/pages/chat/components/chat-composer-slash-menu.tsx":
      // Share interaction-only rows without four separate preload-map entries.
      return "composer-invocation-menus";
    case "ui/src/app/app-root-focus.ts":
    case "ui/src/app/app-root-focus-view.tsx":
      return "focus-dashboard-runtime";
    case "ui/src/components/solid/gateway-url-confirmation.tsx":
      // A pending target owns this dialog; ordinary boot never requests it.
      return "gateway-confirmation-runtime";
    case "ui/src/pages/chat/route-entry.ts":
      // Pending New Session previews must render while the Chat route entry waits.
      return "chat-route-entry";
    case "ui/src/i18n/locales/en-chat-composer.ts":
      // New Session shares composer copy; session copy stays with Chat's boot group.
      return "chat-english";
    case "ui/src/pages/devices/devices-page.tsx":
      return "devices-page";
    case "ui/src/pages/plugins/plugins-page.tsx":
      return "plugins-page";
    case "ui/src/pages/cron/cron-page.tsx":
      return "cron-page";
    case "packages/gateway-protocol/src/capability-consent-error-details.ts":
    case "packages/gateway-protocol/src/install-policy-warning-error-details.ts":
    case "packages/gateway-protocol/src/schema/plugin-declared-surface-groups.ts":
      // Shared protocol readers must not pull the lazy Plugins page into chat.
      return "plugin-contracts-runtime";
    case "ui/src/components/solid/copy-button.tsx":
    case "ui/src/components/copy-button-state.ts":
      // Login recovery also copies commands, before any Chat route can load.
      return "copy-button-runtime";
    case "ui/src/components/login-gate-solid.tsx":
    case "ui/src/components/login-gate-feedback.ts":
    case "ui/src/i18n/locales/en-login.ts":
    case "ui/src/lib/gateway-secret-shape.ts":
      return "login-runtime";
    case "ui/src/components/sidebar-update-card.tsx":
    case "ui/src/styles/sidebar-update-card.css":
      return "sidebar-update-runtime";
    case "ui/src/components/markdown-parser.ts":
      return "markdown-runtime";
    case "ui/src/pages/chat/session-snapshot-database.ts":
      // Warm boot reads while the Gateway connects; the chat boot group made it wait for the whole route.
      return "session-snapshot-database";
  }

  if (
    moduleIdIncludesPackage(id, "solid-js") ||
    moduleIdIncludesPackage(id, "@solidjs/signals") ||
    moduleIdIncludesPackage(id, "@solidjs/web")
  ) {
    // Keep Solid's eager initializers out of route groups, with one compression dictionary.
    return "solid-runtime";
  }

  if (normalized.startsWith(resolvedLocaleConfigHintsModulePrefix)) {
    return `${controlUiLocaleConfigHintsChunkPrefix}${normalized.slice(resolvedLocaleConfigHintsModulePrefix.length)}`;
  }
  if (normalized.startsWith(resolvedLocaleNamespaceModulePrefix)) {
    return `locale-namespace-${normalized.slice(resolvedLocaleNamespaceModulePrefix.length).replace("/", "-")}`;
  }

  // Code highlighting is requested by the first completed code block; it must
  // not share the parser/sanitizer chunk used by ordinary transcript prose.
  if (moduleIdIncludesPackage(id, "highlight.js")) {
    return "markdown-highlight-runtime";
  }
  if (
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    // Keep the parser closure with its lazy consumers, outside stale shared boot captures.
    return "markdown-runtime";
  }

  if (moduleIdIncludesPackage(id, "zod")) {
    return "config-runtime";
  }
  if (moduleIdIncludesPackage(id, "json5")) {
    // Config parsing loads only when a config consumer warms it.
    return "json5-runtime";
  }

  if (moduleIdIncludesPackage(id, "libphonenumber-js")) {
    return "phone-runtime";
  }

  // Keep fallback digests separate so secure contexts only download the signer.
  if (moduleIdIncludesPackage(id, "@noble/ed25519")) {
    return "device-signing-runtime";
  }

  return undefined;
}

export function createControlUiCodeSplitting(options: { includeBootGroups?: boolean } = {}) {
  return {
    includeDependenciesRecursively: false,
    groups: [
      {
        name: (id: string) => controlUiStableChunkName(id) ?? null,
        test: (id: string) => controlUiStableChunkName(id) !== undefined,
        priority: 20,
      },
      {
        name: "control-ui-core",
        test: () => true,
        tags: ["$initial"] as ["$initial"],
        priority: 10,
        maxSize: 1024 * 1024,
      },
      {
        name: "control-ui-lib",
        test: (id: string) => normalizeModuleId(id).includes("/ui/src/lib/"),
        tags: ["$initial"] as ["$initial"],
        priority: 11,
        // Keep initial state owners and utilities together across core entry points.
        maxSize: 1024 * 1024,
      },
      ...(options.includeBootGroups === false
        ? []
        : [
            ...(["shared", "new", "chat"] as const).map((route, index) => {
              const modules = new Set(controlUiBootModules[route]);
              if (route === "shared") {
                // Plugin contributions can initialize after the New Session boot capture.
                modules.add("ui/src/plugins/control-ui-actions.ts");
                // Both routes read deferred resources; share their existing boot partition.
                modules.add("node_modules/@solidjs/signals/dist/prod/deferred.js");
                // Opened person cards share labels with New Session, not its composer chunk.
                modules.add("ui/src/lib/platform-label.ts");
                // Placement and delivery share retries without importing either route's bundle.
                modules.add("ui/src/pages/chat/chat-outbox-retry.ts");
              }
              return {
                name: `control-ui-boot-${route}`,
                test: (id: string) => modules.has(controlUiBootManifestKey(id)),
                // Shared dependencies must be assigned first, or a route group pulls
                // them (and therefore other routes) into its eagerly imported chunk.
                priority: 8 - index,
                includeDependenciesRecursively: true,
                // Shared boot needs a smaller partition cap because its dense chat
                // modules can exceed the compressed-size budget after regrouping.
                // Chat-only code can share a larger compression dictionary;
                // shipped byte/request budgets still bound the output.
                minSize: (route === "chat" ? 384 : 128) * 1024,
                maxSize: (route === "shared" ? 1280 : route === "chat" ? 1664 : 1408) * 1024,
              };
            }),
            ...(["shared", "new", "chat"] as const).map((route) => {
              const styles = new Set(
                controlUiBootModules[route].filter((id) => id.endsWith(".css")),
              );
              return {
                name: `control-ui-boot-${route}-styles`,
                test: (id: string) =>
                  !/[?&]inline(?:[=&]|$)/u.test(id) && styles.has(controlUiBootManifestKey(id)),
                // One stylesheet per measured route set, without per-page JS facades.
                // Keep it separate from core CSS to preserve its existing size ceiling.
                priority: 9,
              };
            }),
          ]),
    ],
  };
}

export const controlUiCodeSplitting = createControlUiCodeSplitting();

export function controlUiIsolatedDesktopRuntimePlugin(): Plugin {
  let config: ResolvedConfig;
  let runtime: Promise<string> | undefined;
  return {
    name: "control-ui-isolated-desktop-runtime",
    apply: "build",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      runtime = undefined;
    },
    async resolveDynamicImport(source, importer) {
      if (source !== "@novnc/novnc") {
        return null;
      }
      // noVNC awaits browser codec detection at module scope. In the main graph,
      // that disables Rolldown's facade optimization even for unrelated boot entries.
      // Bundle it unchanged and retain the desktop owner's dynamic import/await.
      runtime ??= (async () => {
        const resolved = await this.resolve(source, importer);
        if (!resolved) {
          return this.error("Cannot resolve the Control UI desktop runtime");
        }
        const result = await build({
          configFile: false,
          root: config.root,
          publicDir: false,
          logLevel: "silent",
          build: {
            write: false,
            outDir: config.build.outDir,
            minify: config.build.minify,
            target: config.build.target,
            sourcemap: config.build.sourcemap,
            rolldownOptions: {
              input: resolved.id,
              preserveEntrySignatures: "strict",
              output: {
                entryFileNames: `${config.build.assetsDir}/novnc-[hash].js`,
                strictExecutionOrder: true,
                codeSplitting: false,
              },
            },
          },
        });
        if (Array.isArray(result) || !("output" in result)) {
          return this.error("Expected one Control UI desktop runtime build");
        }
        const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);
        if (!entry) {
          return this.error("Control UI desktop runtime build has no entry");
        }
        for (const output of result.output) {
          this.emitFile(
            output.type === "chunk"
              ? {
                  type: "prebuilt-chunk",
                  fileName: output.fileName,
                  code: output.code,
                  exports: output.exports,
                  map: output.map ?? undefined,
                }
              : { type: "asset", fileName: output.fileName, source: output.source },
          );
        }
        // Vite emits the desktop importer and this runtime in the same assets directory.
        return `./${path.posix.basename(entry.fileName)}`;
      })();
      return { id: await runtime, external: true };
    },
  };
}
