import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldownVersion, version as viteVersion, type Plugin } from "vite";
import { controlUiBootManifestKey } from "./control-ui-chunking.ts";

type Chunk = {
  type?: "chunk";
  name: string;
  fileName: string;
  moduleIds: readonly string[];
  imports: readonly string[];
  dynamicImports: readonly string[];
  viteMetadata?: { importedCss: Set<string> };
};
type ChunkGraph = Record<string, Chunk | { type: "asset" }>;

const mappedRoots = new Set(["control-ui-connection", "control-ui-boot-shared"]);
const sourceInputs = [
  fileURLToPath(import.meta.url),
  path.join(path.dirname(fileURLToPath(import.meta.url)), "control-ui-boot-modules.json"),
];

function moduleKey(id: string): string {
  // Inline CSS and ordinary CSS are different modules; pnpm store versions are not.
  return controlUiBootManifestKey(id) + (id.match(/[?#].*$/u)?.[0] ?? "");
}

function chunkKey(chunk: Chunk): string {
  return JSON.stringify([chunk.name, chunk.moduleIds.map(moduleKey)]);
}

function staticClosure(chunks: ChunkGraph): Chunk[] {
  const found = new Map<string, Chunk>();
  const visit = (chunk: ChunkGraph[string] | undefined) => {
    if (!chunk || chunk.type === "asset" || found.has(chunk.fileName)) {
      return;
    }
    found.set(chunk.fileName, chunk);
    chunk.imports.forEach((file) => visit(chunks[file]));
  };
  for (const chunk of Object.values(chunks)) {
    if (chunk.type !== "asset" && mappedRoots.has(chunk.name)) {
      visit(chunk);
    }
  }
  return [...found.values()].toSorted((left, right) =>
    chunkKey(left).localeCompare(chunkKey(right)),
  );
}

function stableName(file: string, index: number): string {
  const extension = path.posix.extname(file);
  const stem = path.posix.basename(file, extension);
  const prefix = `_${index.toString(36)}`;
  if (prefix.length > stem.length) {
    throw new Error(`Control UI import-map name exceeds filename width: ${file}`);
  }
  return `${path.posix.dirname(file)}/${prefix.padEnd(stem.length, "_")}${extension}`;
}

function jsMapping(chunks: ChunkGraph): Map<string, string> {
  return new Map(
    staticClosure(chunks)
      // Nearly every leaf imports this runtime. Keep that native hash dependency.
      .filter((chunk) => chunk.name !== "rolldown-runtime")
      .map((chunk, index) => [chunk.fileName, stableName(chunk.fileName, index)]),
  );
}

function relative(from: string, to: string): string {
  const specifier = path.posix.relative(path.posix.dirname(from), to);
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function replaceReferences(code: string, pairs: Iterable<readonly [string, string]>): string {
  let replaced = code;
  for (const [before, after] of pairs) {
    if (before.length !== after.length) {
      throw new Error("Control UI import-map rewrite changed source-map columns");
    }
    for (const quote of ['"', "'", "`"]) {
      replaced = replaced.replaceAll(`${quote}${before}${quote}`, `${quote}${after}${quote}`);
    }
  }
  return replaced;
}

export function controlUiUpdateCachePlugins(): Plugin[] {
  let configIdentity = "";
  let shape: string | undefined;
  let renderMapped: Map<string, string> | undefined;
  const affected = new Set<string>();
  return [
    {
      name: "control-ui-update-cache-hashes",
      apply: "build",
      enforce: "pre",
      configResolved(config) {
        const sources = [...new Set([...config.configFileDependencies, ...sourceInputs])]
          .map((file) => [
            moduleKey(file),
            createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          ])
          .toSorted(([left], [right]) => left!.localeCompare(right!));
        // Vite fills preload arrays after hashing. Include their configuration and
        // source-owned closure inputs, not just the resolver function's text.
        const preload = config.build.modulePreload;
        configIdentity = JSON.stringify({
          toolchain: [viteVersion, rolldownVersion],
          sources,
          base: config.base,
          cssCodeSplit: config.build.cssCodeSplit,
          target: config.build.target,
          minify: config.build.minify,
          cssMinify: config.build.cssMinify,
          sourcemap: config.build.sourcemap,
          assetsInlineLimit: String(config.build.assetsInlineLimit),
          modulePreload:
            preload === false
              ? false
              : {
                  polyfill: preload.polyfill,
                  resolveDependencies: String(preload.resolveDependencies),
                },
        });
      },
      renderStart() {
        shape = undefined;
        renderMapped = undefined;
        affected.clear();
      },
      renderChunk(code, chunk, _options, { chunks }) {
        if (!shape) {
          const identities = new Map<string, string>();
          for (const item of Object.values(chunks)) {
            for (const id of item.moduleIds) {
              const key = moduleKey(id);
              const previous = identities.get(key);
              if (previous && previous !== id) {
                this.error(`Ambiguous Control UI module identity: ${key}`);
              }
              identities.set(key, id);
            }
          }
          // Ordered module IDs also retain CSS and side-effect import order.
          shape = createHash("sha256")
            .update(configIdentity)
            .update(
              JSON.stringify(
                Object.values(chunks)
                  .map((item) => ({
                    id: chunkKey(item),
                    imports: item.imports.map((file) =>
                      chunks[file] ? chunkKey(chunks[file]) : file,
                    ),
                    dynamicImports: item.dynamicImports.map((file) =>
                      chunks[file] ? chunkKey(chunks[file]) : file,
                    ),
                  }))
                  .toSorted((left, right) => left.id.localeCompare(right.id)),
              ),
            )
            .digest("hex");
        }
        renderMapped ??= jsMapping(chunks);
        const rewritten = replaceReferences(
          code,
          [...renderMapped].map(([real, stable]) => [
            relative(chunk.fileName, real),
            relative(chunk.fileName, stable),
          ]),
        );
        if (rewritten !== code || code.includes("__VITE_PRELOAD__")) {
          affected.add(chunkKey(chunk));
        }
        // Fixed-width substitutions preserve the inherited map, as in Vite's
        // __VITE_IS_MODERN__ replacement. Never add whitespace around a string.
        return rewritten === code ? null : { code: rewritten, map: null };
      },
      augmentChunkHash(chunk) {
        return affected.has(chunkKey(chunk)) ? shape : undefined;
      },
      generateBundle: {
        order: "pre",
        handler(_options, bundle) {
          const mapped = jsMapping(bundle);
          // Let Vite's existing owner discover real JS/CSS preload dependencies.
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === "chunk") {
              chunk.code = replaceReferences(
                chunk.code,
                [...mapped].map(([real, stable]) => [
                  relative(chunk.fileName, stable),
                  relative(chunk.fileName, real),
                ]),
              );
            }
          }
        },
      },
    },
    {
      name: "control-ui-update-cache-import-map",
      apply: "build",
      enforce: "post",
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const mapped = jsMapping(bundle);
          if (!mapped.size) {
            return;
          }
          const runtimes = Object.values(bundle).filter(
            (chunk) => chunk.type === "chunk" && chunk.name === "rolldown-runtime",
          );
          for (const runtime of runtimes) {
            const reachesRuntime = (chunk: Chunk, seen = new Set<string>()): boolean => {
              if (chunk.fileName === runtime.fileName) {
                return true;
              }
              if (seen.has(chunk.fileName)) {
                return false;
              }
              seen.add(chunk.fileName);
              return chunk.imports.some((file) => {
                const imported = bundle[file];
                return (
                  !mapped.has(file) && imported?.type === "chunk" && reachesRuntime(imported, seen)
                );
              });
            };
            for (const chunk of Object.values(bundle)) {
              if (
                chunk.type === "chunk" &&
                chunk.code.includes("__vite__mapDeps") &&
                chunk.code.includes(relative(chunk.fileName, runtime.fileName)) &&
                !reachesRuntime(chunk)
              ) {
                this.error(
                  `Control UI runtime preload lacks a native hash dependency: ${chunk.fileName}`,
                );
              }
            }
          }
          const cssFiles = [
            ...new Set(
              staticClosure(bundle).flatMap((chunk) =>
                Array.from(chunk.viteMetadata?.importedCss ?? []),
              ),
            ),
          ];
          const cssKey = (file: string) =>
            file.replace(/-(?:!~\{[^}]+\}~|[\w-]{8})(?=\.css$)/u, "-STABLE00");
          if (new Set(cssFiles.map(cssKey)).size !== cssFiles.length) {
            this.error("Ambiguous Control UI import-map CSS names");
          }
          cssFiles
            .toSorted((left, right) => cssKey(left).localeCompare(cssKey(right)))
            .forEach((file, index) => mapped.set(file, stableName(file, index)));
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== "chunk") {
              continue;
            }
            const rewritten = replaceReferences(
              chunk.code,
              [...mapped].flatMap(([real, stable]) => [
                [relative(chunk.fileName, real), relative(chunk.fileName, stable)] as const,
                [real, stable] as const,
                [`/${real}`, `/${stable}`] as const,
              ]),
            );
            if (rewritten !== chunk.code && !affected.has(chunkKey(chunk))) {
              this.error(`Control UI final rewrite lacks hash coverage: ${chunk.fileName}`);
            }
            chunk.code = rewritten;
          }
          const html = bundle["index.html"];
          if (!mapped.size || html?.type !== "asset") {
            return;
          }
          const imports = Object.fromEntries(
            [...mapped].map(([real, stable]) => [`./${stable}`, `./${real}`]),
          );
          html.source = String(html.source).replace(
            /<head\b[^>]*>/iu,
            (match) =>
              `${match}<script type="importmap" data-cfasync="false">${JSON.stringify({ imports })}</script>`,
          );
        },
      },
    },
  ];
}
