#!/usr/bin/env -S node --import tsx
// Regenerates ui/config/control-ui-boot-modules.json: the modules shared shell and
// route-specific boot flows need, plus requested dynamic entry points. Builds
// without the previous boot groups, captures ready routes against the mocked
// Gateway, and keeps fetched modules reachable from what each route requested.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import {
  controlUiBootManifestKey,
  createControlUiCodeSplitting,
} from "../config/control-ui-chunking.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../src/test-helpers/control-ui-e2e.ts";
import controlUiViteConfig from "../vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, "ui", "config", "control-ui-boot-modules.json");
const SETTLE_MS = 3_000;
const READY_TIMEOUT_MS = 60_000;

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveDist(distDir: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (urlPath === "/control-ui-config.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ basePath: "/", assistantName: "", assistantAvatar: "" }));
      return;
    }
    let filePath = path.join(distDir, urlPath === "/" ? "index.html" : urlPath.slice(1));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    res.setHeader("Content-Type", mime[path.extname(filePath)] ?? "application/octet-stream");
    res.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        throw new Error("Control UI boot manifest server has no port");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

function readDistBuildId(distDir: string): string {
  const swSource = fs.readFileSync(path.join(distDir, "sw.js"), "utf8");
  const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(swSource)?.[1];
  if (!buildId) {
    throw new Error("Control UI boot manifest cannot read the dist build id from sw.js");
  }
  return buildId;
}

async function collectBootChunkPaths(
  baseUrl: string,
  distDir: string,
  route: "new" | "chat",
): Promise<Set<string>> {
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  try {
    const page = await browser.newPage();
    const chunkPaths = new Set<string>();
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/assets/") && pathname.endsWith(".js")) {
        chunkPaths.add(pathname);
      }
    });
    await installMockGateway(page, { serverBuildId: readDistBuildId(distDir) });
    await page.goto(`${baseUrl}/${route}`, { waitUntil: "commit" });
    // Route readiness proves the capture did not stall on an error surface.
    await page
      .locator(
        route === "chat" ? ".agent-chat__composer-combobox textarea" : ".new-session-page__message",
      )
      .waitFor({ timeout: READY_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    return chunkPaths;
  } finally {
    await browser.close();
  }
}

function manifestKeysForChunks(chunkPaths: Iterable<string>, distDir: string): string[] {
  const keys = new Set<string>();
  for (const chunkPath of chunkPaths) {
    const mapPath = path.join(distDir, `${chunkPath}.map`);
    if (!fs.existsSync(mapPath)) {
      // Facade chunks for dynamic entries can omit maps; their modules are
      // covered by the chunks that carry the actual code.
      continue;
    }
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { sources?: string[] };
    for (const source of map.sources ?? []) {
      keys.add(controlUiBootManifestKey(path.resolve(path.join(distDir, "assets"), source)));
    }
  }
  return [...keys].toSorted();
}

type BootCaptureGraph = {
  entryModules: string[];
  // Dynamic-entry facade chunk path -> facade module id.
  dynamicEntries: Map<string, string>;
  moduleChunks: Map<string, string>;
  imports: Map<string, { static: readonly string[]; dynamic: readonly string[] }>;
};

function routeModuleKeys(
  graph: BootCaptureGraph,
  chunks: ReadonlySet<string>,
  roots: readonly string[],
): Set<string> {
  const facades = new Set(graph.dynamicEntries.values());
  const seen = new Set<string>();
  const pending = [...roots];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const imports = graph.imports.get(id);
    pending.push(...(imports?.static ?? []));
    // A dynamic import without its own facade chunk resolves to the chunk that
    // holds its target. Once that chunk is loaded the import sends no request,
    // so the capture cannot tell whether it ran; keep its dependencies.
    for (const target of imports?.dynamic ?? []) {
      const chunk = graph.moduleChunks.get(target);
      if (!facades.has(target) && chunk !== undefined && chunks.has(chunk)) {
        pending.push(target);
      }
    }
  }
  return new Set([...seen].map(controlUiBootManifestKey));
}

function partitionBootKeys(routes: Record<"new" | "chat", Set<string>>) {
  const shared = new Set([...routes.new].filter((key) => routes.chat.has(key)));
  const sorted = (keys: Iterable<string>) =>
    [...keys].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    shared: sorted(shared),
    new: sorted([...routes.new].filter((key) => !shared.has(key))),
    chat: sorted([...routes.chat].filter((key) => !shared.has(key))),
  };
}

async function main(): Promise<void> {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-boot-"));
  try {
    const config = controlUiViteConfig({ outDir: distDir });
    const graph: BootCaptureGraph = {
      entryModules: [],
      dynamicEntries: new Map(),
      moduleChunks: new Map(),
      imports: new Map(),
    };
    await build({
      ...config,
      configFile: false,
      root: path.join(repoRoot, "ui"),
      plugins: [
        config.plugins,
        {
          name: "control-ui-measure-boot-dependencies",
          outputOptions(options) {
            // Old JavaScript and CSS boot groups would keep stale modules in fetched chunks,
            // feeding them back into every regenerated manifest.
            return {
              ...options,
              codeSplitting: createControlUiCodeSplitting({ includeBootGroups: false }),
            };
          },
          generateBundle(_options, bundle) {
            for (const id of this.getModuleIds()) {
              const info = this.getModuleInfo(id);
              graph.imports.set(id, {
                static: info?.importedIds ?? [],
                dynamic: info?.dynamicallyImportedIds ?? [],
              });
            }
            for (const chunk of Object.values(bundle)) {
              if (chunk.type !== "chunk") {
                continue;
              }
              for (const id of chunk.moduleIds) {
                graph.moduleChunks.set(id, `/${chunk.fileName}`);
              }
              if (chunk.isEntry && chunk.facadeModuleId) {
                graph.entryModules.push(chunk.facadeModuleId);
              }
              if (chunk.isDynamicEntry && chunk.facadeModuleId) {
                graph.dynamicEntries.set(`/${chunk.fileName}`, chunk.facadeModuleId);
              }
            }
          },
        },
      ],
    });
    const server = await serveDist(distDir);
    try {
      const routes = { new: new Set<string>(), chat: new Set<string>() };
      const routeEntries = { new: new Set<string>(), chat: new Set<string>() };
      for (const route of ["new", "chat"] as const) {
        const chunks = await collectBootChunkPaths(server.baseUrl, distDir, route);
        const requestedEntries = [...chunks].flatMap(
          (chunk) => graph.dynamicEntries.get(chunk) ?? [],
        );
        routeEntries[route] = new Set(requestedEntries.map(controlUiBootManifestKey));
        // Fetched shared chunks can co-locate modules only the other route
        // imports; keep the modules reachable from what this route requested.
        const needed = routeModuleKeys(graph, chunks, [...graph.entryModules, ...requestedEntries]);
        const fetched = manifestKeysForChunks(chunks, distDir);
        routes[route] = new Set(fetched.filter((key) => needed.has(key)));
        if (routes[route].size < 100) {
          throw new Error(
            `Boot capture looks truncated: ${route} recorded only ${routes[route].size} modules`,
          );
        }
        console.log(
          `control-ui-boot-manifest: ${route}: ${chunks.size} chunks, ${routes[route].size} of ${fetched.length} fetched modules reachable, ${routeEntries[route].size} dynamic entries`,
        );
      }
      const modules = partitionBootKeys(routes);
      const manifest = {
        ...modules,
        entries: partitionBootKeys(routeEntries),
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
      console.log(
        `control-ui-boot-manifest: ${Object.entries(modules)
          .map(([name, keys]) => `${name}: ${keys.length}`)
          .join(", ")} -> ${path.relative(repoRoot, manifestPath)}`,
      );
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  console.error("[control-ui-boot-manifest] FAILED (exit 1)");
  process.exit(1);
});
