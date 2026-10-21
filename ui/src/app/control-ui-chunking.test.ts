// @vitest-environment node
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  controlUiBootManifestKey,
  controlUiCodeSplitting,
  controlUiStableChunkName,
} from "../../config/control-ui-chunking.ts";

describe("Control UI build chunking", () => {
  it("keeps the optional JSON5 parser outside the eager validation graph", async () => {
    const zod = new URL("../../node_modules/zod/index.js", import.meta.url).pathname;
    const json5 = new URL("../../node_modules/json5/dist/index.mjs", import.meta.url).pathname;
    const entry = "\0config-parser-fixture";
    const sources = new Map([
      [
        entry,
        `export { validate } from ${JSON.stringify(zod)}; export const warm = () => import(${JSON.stringify(json5)});`,
      ],
      [zod, "export const validate = () => true;"],
      [json5, "export const parse = () => ({});"],
    ]);
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      plugins: [
        {
          name: "config-parser-fixture",
          enforce: "pre",
          resolveId: (id) => (sources.has(id) ? id : null),
          load: (id) => sources.get(id) ?? null,
        },
      ],
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: entry,
          preserveEntrySignatures: "allow-extension",
          output: { codeSplitting: controlUiCodeSplitting, strictExecutionOrder: true },
        },
      },
    });
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const entryChunk = chunks.find((chunk) => chunk.isEntry)!;
    const parserChunk = chunks.find((chunk) => json5 in chunk.modules)!;
    const dependencies = new Set<string>();
    const visit = (file: string) => {
      if (dependencies.has(file)) {
        return;
      }
      dependencies.add(file);
      chunks.find((chunk) => chunk.fileName === file)?.imports.forEach(visit);
    };
    visit(entryChunk.fileName);
    expect(dependencies.has(parserChunk.fileName)).toBe(false);
    expect(entryChunk.dynamicImports).toContain(parserChunk.fileName);
  });

  it("keeps routes and optional code lazy with one shared stylesheet", async () => {
    const modulePath = (relative: string) => new URL(relative, import.meta.url).pathname;
    const chat = modulePath("../pages/chat/chat-pane.tsx");
    const newSession = modulePath("../pages/new-session/new-session-page.tsx");
    const optional = modulePath("../components/assistant-panel-content.ts");
    const devices = modulePath("../pages/devices/devices-page.tsx");
    const sharedUi = modulePath("../components/select-picker-view.tsx");
    const sharedStyle = modulePath("../styles/mcp-app-extensions.css");
    const sidebarStyle = modulePath("../styles/sidebar-reorder.css");
    const entry = "\0cold-load-fixture";
    const sources = new Map([
      [
        entry,
        `export const chat = () => import(${JSON.stringify(chat)}); export const newSession = () => import(${JSON.stringify(newSession)}); export const devices = () => import(${JSON.stringify(devices)});`,
      ],
      [
        chat,
        `import ${JSON.stringify(sharedStyle)}; import { label } from ${JSON.stringify(sharedUi)}; export class Chat { label = label; } export const openPanel = () => import(${JSON.stringify(optional)});`,
      ],
      [
        newSession,
        `import ${JSON.stringify(sidebarStyle)}; import { label } from ${JSON.stringify(sharedUi)}; export class NewSession { label = label; }`,
      ],
      [optional, 'export const panel = "optional-panel";'],
      [devices, 'export const page = "devices-page";'],
      [sharedUi, 'export const label = "shared-ui";'],
      [sharedStyle, ".shared-fixture { color: red; }"],
      [sidebarStyle, ".sidebar-fixture { color: blue; }"],
    ]);
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      plugins: [
        {
          name: "cold-load-fixture",
          enforce: "pre",
          resolveId: (id) => (sources.has(id) ? id : null),
          load: (id) => sources.get(id) ?? null,
        },
      ],
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: entry,
          preserveEntrySignatures: "allow-extension",
          output: {
            codeSplitting: {
              ...controlUiCodeSplitting,
              // A stale capture must not pull a lazy page into the shared boot chunk.
              groups: controlUiCodeSplitting.groups.map((group) =>
                group.name === "control-ui-boot-shared"
                  ? { ...group, test: (id: string) => id === devices || group.test(id) }
                  : group,
              ),
            },
            strictExecutionOrder: true,
          },
        },
      },
    });
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const styles = result.output.filter(
      (asset) => asset.type === "asset" && asset.fileName.endsWith(".css"),
    );
    expect(styles).toHaveLength(1);
    expect(styles[0]).toMatchObject({ source: expect.stringContaining(".shared-fixture") });
    expect(styles[0]).toMatchObject({ source: expect.stringContaining(".sidebar-fixture") });
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const chatChunk = chunks.find((chunk) => chat in chunk.modules)!;
    const newSessionChunk = chunks.find((chunk) => newSession in chunk.modules)!;
    const staticImports = (fileName: string, visited = new Set<string>()): Set<string> => {
      if (!visited.has(fileName)) {
        visited.add(fileName);
        for (const imported of chunks.find((chunk) => chunk.fileName === fileName)!.imports) {
          staticImports(imported, visited);
        }
      }
      return visited;
    };
    expect(staticImports(chatChunk.fileName)).not.toContain(newSessionChunk.fileName);
    expect(staticImports(newSessionChunk.fileName)).not.toContain(chatChunk.fileName);
    const devicesChunk = chunks.find((chunk) => devices in chunk.modules)!;
    expect(staticImports(chatChunk.fileName)).not.toContain(devicesChunk.fileName);
    expect(staticImports(newSessionChunk.fileName)).not.toContain(devicesChunk.fileName);
    const deferred = chunks.find((chunk) => optional in chunk.modules)!;
    expect(deferred).toBeDefined();
    expect(chunks.filter((chunk) => chunk.imports.includes(deferred.fileName))).toHaveLength(0);
  });

  it("groups stable runtime dependencies into bounded chunks", () => {
    expect(controlUiCodeSplitting.includeDependenciesRecursively).toBe(false);
    expect(controlUiCodeSplitting.groups[1]).toMatchObject({
      tags: ["$initial"],
      maxSize: 1024 * 1024,
    });
    for (const [id, expected] of [
      ["/repo/ui/node_modules/highlight.js/lib/core.js", "markdown-highlight-runtime"],
      ["/repo/ui/node_modules/markdown-it/dist/markdown-it.mjs", undefined],
      ["/repo/ui/node_modules/entities/dist/esm/index.js", undefined],
      [String.raw`C:\repo\ui\node_modules\highlight.js\lib\core.js`, "markdown-highlight-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/dompurify/dist/purify.es.mjs", "markdown-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/zod/v4/core/schemas.js", "config-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/json5/dist/index.js", "json5-runtime"],
      [
        "/tmp/openclaw-pnpm-node-modules/libphonenumber-js/max/exports/parsePhoneNumber.js",
        "phone-runtime",
      ],
      ["/tmp/openclaw-pnpm-node-modules/@noble/ed25519/index.js", "gateway-runtime"],
      ["/repo/ui/src/lib/gateway-methods.ts", "gateway-runtime"],
      [
        new URL("../components/sidebar-update-card.tsx", import.meta.url).pathname,
        "sidebar-update-runtime",
      ],
      [
        new URL("../styles/sidebar-update-card.css", import.meta.url).pathname,
        "sidebar-update-runtime",
      ],
      [new URL("../pages/chat/route-entry.ts", import.meta.url).pathname, "chat-route-entry"],
      [new URL("../pages/cron/cron-page.tsx", import.meta.url).pathname, "cron-page"],
      [new URL("../pages/plugins/plugins-page.tsx", import.meta.url).pathname, "plugins-page"],
      [new URL("../components/markdown-parser.ts", import.meta.url).pathname, "markdown-runtime"],
      ["/repo/ui/src/components/config-form.shared.ts", undefined],
      ["/repo/ui/src/lib/clipboard.ts", undefined],
      ["/repo/ui/src/build-info.ts", undefined],
      ["/repo/ui/src/build-info-normalizers.ts", undefined],
      ["/repo/ui/src/app/app-host.tsx", undefined],
      ["\0virtual:openclaw-control-ui-locale-config-hints/ru", "locale-config-hints-ru"],
      ["\0virtual:openclaw-control-ui-locale/ru", undefined],
    ] as const) {
      expect(controlUiStableChunkName(id), id).toBe(expected);
    }
  });

  it("lets snapshot prewarming load independently of the measured boot groups", () => {
    const database = new URL("../pages/chat/session-snapshot-database.ts", import.meta.url)
      .pathname;
    const stableGroup = controlUiCodeSplitting.groups[0];
    const bootGroup = controlUiCodeSplitting.groups.find(
      (group) =>
        typeof group.name === "string" &&
        /^control-ui-boot-(?:shared|new|chat)$/u.test(group.name) &&
        group.test?.(database),
    )!;

    expect(bootGroup).toBeDefined();
    expect(stableGroup?.test?.(database)).toBe(true);
    expect(controlUiStableChunkName(database)).toBe("session-snapshot-database");
    expect(stableGroup?.priority).toBeGreaterThan(bootGroup.priority);
  });

  it("consolidates shared boot without pulling in the chat route or optional panels", () => {
    // Recursive inclusion is a correctness requirement for this group: merging
    // the lazy boot graph without it emitted chunks whose execution order broke
    // at application start.
    const sharedGroup = controlUiCodeSplitting.groups.find(
      (group) => group.name === "control-ui-boot-shared",
    );
    expect(sharedGroup).toMatchObject({ includeDependenciesRecursively: true });
    const bootGroup = sharedGroup as {
      test: (id: string) => boolean;
    };
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
    // Representative always-loaded boot surface and a lazy island that must
    // keep its own chunk (terminal runtime is not part of the default boot).
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar.tsx`)).toBe(true);
    // Chat reaches narration through a dynamic import without a request of its own.
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar-session-narration.ts`)).toBe(
      true,
    );
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/chat/chat-page.tsx`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/cron/cron-page.tsx`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/plugins/plugins-page.tsx`)).toBe(false);
    // Fetched shared chunks once co-located the chat view with modules New Session needs.
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/chat/chat-view.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/styles/chat.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/components/assistant-panel-content.ts`)).toBe(false);
    // Opening state stays cheap; rendering the debug overlay belongs to its lazy graph.
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-state.ts`)).toBe(true);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-content.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-frame.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-loading.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/node_modules/ghostty-web/dist/index.js`)).toBe(false);
  });

  it("derives stable manifest keys across pnpm layouts and platforms", () => {
    expect(
      controlUiBootManifestKey(
        "/repo/node_modules/.pnpm/nanoid@5.0.0/node_modules/nanoid/index.browser.js",
      ),
    ).toBe("node_modules/nanoid/index.browser.js");
    expect(
      controlUiBootManifestKey(
        "/repo/node_modules/@example/control/node_modules/nanoid/index.browser.js",
      ),
    ).toBe("node_modules/nanoid/index.browser.js");
    expect(controlUiBootManifestKey("/repo/ui/src/main.ts?html-proxy&index=0.js")).not.toContain(
      "?",
    );
    expect(controlUiBootManifestKey(String.raw`C:\repo\node_modules\nanoid\index.browser.js`)).toBe(
      "node_modules/nanoid/index.browser.js",
    );
  });
});
