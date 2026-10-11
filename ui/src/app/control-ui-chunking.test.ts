// @vitest-environment node
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  controlUiBootManifestKey,
  controlUiCodeSplitting,
  controlUiStableChunkName,
} from "../../config/control-ui-chunking.ts";

describe("Control UI build chunking", () => {
  it("emits one measured shared stylesheet while keeping optional code lazy", async () => {
    const modulePath = (relative: string) => new URL(relative, import.meta.url).pathname;
    const chat = modulePath("../pages/chat/chat-pane.ts");
    const newSession = modulePath("../pages/new-session/new-session-page.ts");
    const optional = modulePath("../components/assistant-panel-content.ts");
    const sharedStyle = modulePath("../styles/hub-tabs.css");
    const sidebarStyle = modulePath("../styles/sidebar-issues.css");
    const entry = "\0cold-load-fixture";
    const sources = new Map([
      [
        entry,
        `export const chat = () => import(${JSON.stringify(chat)}); export const newSession = () => import(${JSON.stringify(newSession)});`,
      ],
      [
        chat,
        `import ${JSON.stringify(sharedStyle)}; export const openPanel = () => import(${JSON.stringify(optional)});`,
      ],
      [newSession, `import ${JSON.stringify(sidebarStyle)}; export const ready = true;`],
      [optional, 'export const panel = "optional-panel";'],
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
          output: { codeSplitting: controlUiCodeSplitting, strictExecutionOrder: true },
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
      ["/repo/ui/node_modules/lit/index.js", "lit-runtime"],
      ["/repo/ui/node_modules/lit-html/directives/repeat.js", "lit-runtime"],
      ["/repo/ui/node_modules/highlight.js/lib/core.js", "markdown-runtime"],
      [String.raw`C:\repo\ui\node_modules\highlight.js\lib\core.js`, "markdown-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/dompurify/dist/purify.es.mjs", "markdown-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/zod/v4/core/schemas.js", "config-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/json5/dist/index.js", "config-runtime"],
      [
        "/tmp/openclaw-pnpm-node-modules/libphonenumber-js/max/exports/parsePhoneNumber.js",
        "phone-runtime",
      ],
      ["/tmp/openclaw-pnpm-node-modules/@noble/ed25519/index.js", "gateway-runtime"],
      ["/repo/ui/src/lib/gateway-methods.ts", "gateway-runtime"],
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
    for (const [name, directive] of [
      ["lit", "cache"],
      ["lit-html", "cache"],
      ["lit", "until"],
      ["lit-html", "until"],
      ["lit-html", "private-async-helpers"],
    ]) {
      expect(
        controlUiStableChunkName(`/repo/node_modules/${name}/directives/${directive}.js`),
      ).toBeUndefined();
      expect(
        controlUiStableChunkName(`C:\\repo\\node_modules\\${name}\\directives\\${directive}.js`),
      ).toBeUndefined();
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
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar.ts`)).toBe(true);
    // Chat reaches narration through a dynamic import without a request of its own.
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar-session-narration.ts`)).toBe(
      true,
    );
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/chat/chat-page.ts`)).toBe(false);
    // Fetched shared chunks once co-located the chat view with modules New Session needs.
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/chat/chat-view.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/styles/chat.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/components/assistant-panel-content.ts`)).toBe(false);
    // Opening state stays cheap; rendering the debug overlay belongs to its lazy graph.
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-contract.ts`)).toBe(true);
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
        "/repo/node_modules/@awesome.me/webawesome/node_modules/nanoid/index.browser.js",
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
