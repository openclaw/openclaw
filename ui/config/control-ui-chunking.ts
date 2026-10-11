// Control UI config module wires control ui chunking behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type ResolvedConfig } from "vite";
import { resolvedLocaleConfigHintsModulePrefix } from "./control-ui-locales.ts";

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
    case "packages/gateway-protocol/src/capability-consent-error-details.ts":
    case "packages/gateway-protocol/src/install-policy-warning-error-details.ts":
    case "packages/gateway-protocol/src/schema/plugin-install-progress.ts":
      // Shared protocol readers must not pull the lazy Plugins page into chat.
      return "plugin-contracts-runtime";
    case "ui/src/components/login-gate.ts":
    case "ui/src/components/login-gate-feedback.ts":
    case "ui/src/i18n/locales/en-login.ts":
    case "ui/src/lib/gateway-secret-shape.ts":
      return "login-runtime";
    case "ui/src/components/sidebar-update-card.tsx":
    case "ui/src/styles/sidebar-update-card.css":
      return "sidebar-update-runtime";
    case "ui/src/pages/cron/cron-page.tsx":
      // Keep the optional page out of shared boot discovery after regrouping.
      return "cron-page";
    case "ui/src/pages/chat/session-snapshot-database.ts":
      // Warm boot reads while the Gateway connects; the chat boot group made it wait for the whole route.
      return "session-snapshot-database";
  }

  if (normalized.startsWith(resolvedLocaleConfigHintsModulePrefix)) {
    return `${controlUiLocaleConfigHintsChunkPrefix}${normalized.slice(resolvedLocaleConfigHintsModulePrefix.length)}`;
  }

  if (normalized.endsWith("/ui/src/lib/gateway-methods.ts")) {
    return "gateway-runtime";
  }

  if (
    normalized.endsWith("/ui/src/styles/chat/grouped.css") ||
    normalized.endsWith("/ui/src/styles/chat/message-layout.css")
  ) {
    // Both routes load transcript styles; keep them outside the larger shared boot stylesheet.
    return "chat-transcript-styles";
  }

  if (
    moduleIdIncludesPackage(id, "lit") ||
    moduleIdIncludesPackage(id, "lit-html") ||
    moduleIdIncludesPackage(id, "@lit/reactive-element")
  ) {
    // These directives have only deferred consumers. Keep
    // their implementation and helpers with those consumers, outside startup.
    return /\/directives\/(?:cache|guard|unsafe-html|until|private-async-helpers)\.js$/u.test(
      normalized,
    )
      ? undefined
      : "lit-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "highlight.js") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    return "markdown-runtime";
  }

  if (moduleIdIncludesPackage(id, "zod") || moduleIdIncludesPackage(id, "json5")) {
    return "config-runtime";
  }

  if (moduleIdIncludesPackage(id, "libphonenumber-js")) {
    return "phone-runtime";
  }

  // @noble/hashes stays out of this startup chunk deliberately: it is only
  // dynamically imported as the insecure-context fallback digest provider.
  if (moduleIdIncludesPackage(id, "@noble/ed25519") || moduleIdIncludesPackage(id, "ipaddr.js")) {
    return "gateway-runtime";
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
        name: (id: string) =>
          normalizeModuleId(id).includes("/ui/src/") ? "control-ui-core" : "control-ui-foundation",
        tags: ["$initial"] as ["$initial"],
        priority: 10,
        // Keep the boot graph in fewer partitions; the performance checker owns
        // the compressed-size and request budgets for the emitted chunks.
        maxSize: 1024 * 1024,
      },
      ...(options.includeBootGroups === false
        ? []
        : [
            ...(["shared", "new", "chat"] as const).map((route, index) => {
              const modules = new Set(controlUiBootModules[route]);
              return {
                name: `control-ui-boot-${route}`,
                test: (id: string) => modules.has(controlUiBootManifestKey(id)),
                // Shared dependencies must be assigned first, or a route group pulls
                // them (and therefore other routes) into its eagerly imported chunk.
                priority: 8 - index,
                includeDependenciesRecursively: true,
                // Keep shared chunks together without exceeding the compressed-size budget.
                minSize: 16 * 1024,
                maxSize: 1408 * 1024,
              };
            }),
            ...(["shared", "new", "chat"] as const).map((route) => {
              const styles = new Set(
                controlUiBootModules[route].filter((id) => id.endsWith(".css")),
              );
              return {
                name: `control-ui-boot-${route}-styles`,
                test: (id: string) => styles.has(controlUiBootManifestKey(id)),
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
