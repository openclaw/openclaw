// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { controlUiBootPreloadsPlugin } from "../../config/control-ui-boot-preloads.ts";
import {
  controlUiCodeSplitting,
  createControlUiCodeSplitting,
  controlUiIsolatedDesktopRuntimePlugin,
} from "../../config/control-ui-chunking.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());

function routePreloads(html: string, route: "chat" | "new"): string[] {
  const template = new RegExp(
    `<template data-openclaw-route-preloads="${route}">([\\s\\S]*?)</template>`,
    "u",
  ).exec(html);
  expect(template).not.toBeNull();
  return [...template![1]!.matchAll(/href="\.\/([^"]+)"/gu)].map((match) => match[1]!);
}

async function buildFixture(
  root: string,
  outDir: string,
  sources: Record<string, string>,
  aliases: Record<string, string>,
  plugins: Plugin[] = [],
  codeSplitting = controlUiCodeSplitting,
) {
  const result = await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: "preload-build-fixture",
        enforce: "pre",
        resolveId: (source) => (Object.hasOwn(aliases, source) ? aliases[source] : null),
        load: (id) => (Object.hasOwn(sources, id) ? sources[id] : null),
      },
      ...plugins,
      controlUiBootPreloadsPlugin(),
    ],
    build: {
      outDir,
      minify: false,
      target: "esnext",
      modulePreload: false,
      rolldownOptions: { output: { strictExecutionOrder: true, codeSplitting } },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected one Control UI fixture bundle");
  }
  return {
    outDir,
    chunks: result.output.filter((output) => output.type === "chunk"),
    html: await fs.readFile(path.join(outDir, "index.html"), "utf8"),
  };
}

it.each([false, true])(
  "keeps desktop lazy and prioritizes route dependencies: %s",
  async (hasComposer) => {
    const root = tempDirs.make("control-ui-isolated-desktop-");
    const local = (name: string) => path.join(root, name);
    const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url));
    const desktop = local("desktop.js");
    const sidebar = modulePath("../components/app-sidebar.tsx");
    const outbox = modulePath("../lib/chat/outbox-store-projection.ts");
    const chat = modulePath("../pages/chat/route-loader.ts");
    const composer = modulePath("../pages/chat/components/chat-composer.tsx");
    const composerInteraction = modulePath("../pages/chat/components/chat-composer-slash-menu.tsx");
    // Real manifest entry IDs and payloads above the production group's minimum size.
    const sidebarValue = "sidebar-value-".repeat(12_000);
    const outboxValue = "outbox-value-".repeat(12_000);
    const chatValue = "chat-value-".repeat(50_000);
    const sources: Record<string, string> = {
      [sidebar]: `import pluginStyle from ${JSON.stringify(local("plugin.css?url"))}; globalThis.desktopBuildFixture.pluginStyle = pluginStyle; globalThis.desktopBuildFixture.events.push("sidebar"); export const value = ${JSON.stringify(sidebarValue)};`,
      [outbox]: `globalThis.desktopBuildFixture.events.push("outbox"); export const value = ${JSON.stringify(outboxValue)};`,
      [chat]: `${hasComposer ? 'import "fixture:composer";' : ""} globalThis.desktopBuildFixture.events.push("chat"); export const value = ${JSON.stringify(chatValue)};`,
      [composer]: 'globalThis.desktopBuildFixture.events.push("composer");',
      [composerInteraction]: 'globalThis.desktopBuildFixture.events.push("composer-interaction");',
    };
    const files = {
      "package.json": '{"type":"module"}',
      "plugin.css": ".plugin-view { color: red; }",
      "index.html":
        '<html><head></head><body><script type="module" src="./main.js"></script></body></html>',
      "main.js": `globalThis.desktopBuildFixture.loadSidebar = () => import("fixture:sidebar");
       globalThis.desktopBuildFixture.loadOutbox = () => import("fixture:outbox");
       globalThis.desktopBuildFixture.loadChat = () => import("fixture:chat");
       globalThis.desktopBuildFixture.loadComposerInteraction = () => import("fixture:composer-interaction");
       globalThis.desktopBuildFixture.loadDesktop = () => import("@novnc/novnc");`,
      "desktop.js": `globalThis.desktopBuildFixture.events.push("desktop");
       globalThis.desktopBuildFixture.entered();
       const codec = await globalThis.desktopBuildFixture.codecReady;
       export default class RemoteDesktop { static codec = codec; }`,
    };
    await Promise.all(
      Object.entries(files).map(([name, content]) => fs.writeFile(local(name), content)),
    );
    const aliases: Record<string, string> = {
      "@novnc/novnc": desktop,
      "fixture:sidebar": sidebar,
      "fixture:outbox": outbox,
      "fixture:chat": chat,
      "fixture:composer": composer,
      "fixture:composer-interaction": composerInteraction,
    };
    const original = await buildFixture(root, local("original"), sources, aliases);
    const isolated = await buildFixture(root, local("isolated"), sources, aliases, [
      controlUiIsolatedDesktopRuntimePlugin(),
    ]);
    const shared = isolated.chunks.find(
      (chunk) => sidebar in chunk.modules && outbox in chunk.modules,
    );
    const chatChunk = isolated.chunks.find((chunk) => chat in chunk.modules);
    const interactionChunk = isolated.chunks.find((chunk) => composerInteraction in chunk.modules);
    for (const route of ["chat", "new"] as const) {
      const before = routePreloads(original.html, route);
      const after = routePreloads(isolated.html, route);
      expect(after).toEqual(
        expect.arrayContaining(
          route === "chat"
            ? [shared!.fileName, chatChunk!.fileName, interactionChunk!.fileName]
            : [shared!.fileName, interactionChunk!.fileName],
        ),
      );
      expect(after).toHaveLength(route === "chat" ? 3 : 2);
      expect(before.length).toBeGreaterThan(after.length);
      const routeHints = new RegExp(
        `<template data-openclaw-route-preloads="${route}">([\\s\\S]*?)</template>`,
        "u",
      ).exec(isolated.html)?.[1];
      const hints = routeHints?.match(/<link[^>]*>/gu) ?? [];
      expect(hints.find((hint) => hint.includes(shared!.fileName))).not.toContain(
        'fetchpriority="low"',
      );
      expect(hints.find((hint) => hint.includes(interactionChunk!.fileName))).toContain(
        'fetchpriority="low"',
      );
      expect(hints.find((hint) => hint.includes(interactionChunk!.fileName))).toContain(
        'rel="preload" as="script"',
      );
      if (route === "chat") {
        const chatHint = hints.find((hint) => hint.includes(chatChunk!.fileName));
        expect(chatHint).toBeDefined();
        expect(chatHint).not.toContain('fetchpriority="low"');
      }
    }
    const desktopChunk = isolated.chunks.find((chunk) => chunk.exports.includes("default"));
    expect(isolated.html).not.toContain(desktopChunk!.fileName);

    const entered = Promise.withResolvers<void>();
    const codec = Promise.withResolvers<string>();
    const notLoaded = async <T>(): Promise<T> => {
      throw new Error("Fixture entry has not loaded");
    };
    const events: string[] = [];
    const fixture = {
      events,
      entered: entered.resolve,
      codecReady: codec.promise,
      loadSidebar: notLoaded<{ value: string }>,
      loadOutbox: notLoaded<{ value: string }>,
      loadChat: notLoaded<{ value: string }>,
      loadDesktop: notLoaded<{ default: { codec: string } }>,
    };
    vi.stubGlobal("desktopBuildFixture", fixture);
    const entry = isolated.chunks.find((chunk) => chunk.isEntry);
    await import(
      /* @vite-ignore */ pathToFileURL(path.join(isolated.outDir, entry!.fileName)).href
    );
    expect(fixture.events).toEqual([]);
    await expect(fixture.loadSidebar()).resolves.toMatchObject({ value: sidebarValue });
    expect(fixture.events).toEqual(["sidebar"]);
    await expect(fixture.loadOutbox()).resolves.toMatchObject({ value: outboxValue });
    expect(fixture.events).toEqual(["sidebar", "outbox"]);
    await expect(fixture.loadChat()).resolves.toMatchObject({ value: chatValue });
    const chatEvents = ["sidebar", "outbox", ...(hasComposer ? ["composer"] : []), "chat"];
    expect(fixture.events).toEqual(chatEvents);

    let resolved = false;
    const loadingDesktop = fixture.loadDesktop().then((module) => {
      resolved = true;
      return module;
    });
    try {
      await Promise.race([entered.promise, loadingDesktop]);
      expect(fixture.events).toEqual([...chatEvents, "desktop"]);
      expect(resolved).toBe(false);
    } finally {
      codec.resolve("h264");
    }
    expect((await loadingDesktop).default.codec).toBe("h264");
  },
);

it("prioritizes signing and route dependencies over unevaluated interaction hints", async () => {
  const root = tempDirs.make("control-ui-renderer-preloads-");
  const local = (name: string) => path.join(root, name);
  const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  const commonDependency = local("renderer-dependency.js");
  const placementDependency = local("placement-dependency.js");
  const signingFallback = local("signing-fallback.js");
  const entries = {
    online: modulePath("../components/app-sidebar-online.tsx"),
    catalog: modulePath("../components/mcp-app-catalog-view.tsx"),
    placement: modulePath("./session-placement-startup.runtime.ts"),
    creator: modulePath("../pages/claws/creator-review-view.tsx"),
    signer: modulePath("../lib/nodes/device-signing.runtime.ts"),
    chat: modulePath("../pages/chat/route-entry.ts"),
  };
  const aliases: Record<string, string> = {
    "fixture:common": commonDependency,
    "fixture:placement-dependency": placementDependency,
    "fixture:signing-fallback": signingFallback,
  };
  const sources: Record<string, string> = {
    [commonDependency]:
      'globalThis.preloadBuildFixture.events.push("common"); export const value = "common";',
    [placementDependency]:
      'globalThis.preloadBuildFixture.events.push("placement-dependency"); export const value = "placement";',
    [signingFallback]: 'export const value = "fallback";',
  };
  for (const [name, id] of Object.entries(entries)) {
    aliases[`fixture:${name}`] = id;
    const dependency = name === "placement" ? "fixture:placement-dependency" : "fixture:common";
    sources[id] = `import { value as dependency } from ${JSON.stringify(dependency)};
      globalThis.preloadBuildFixture.events.push(${JSON.stringify(name)});
      export const value = dependency;`;
  }
  sources[entries.signer] = `globalThis.preloadBuildFixture.events.push("signer");
    export const value = "signer";
    export const fallback = () => import("fixture:signing-fallback");`;
  await fs.writeFile(local("package.json"), '{"type":"module"}');
  await fs.writeFile(
    local("index.html"),
    '<html><head></head><body><script type="module" src="./main.js"></script></body></html>',
  );
  await fs.writeFile(
    local("main.js"),
    Object.keys(entries)
      .map(
        (name) =>
          `globalThis.preloadBuildFixture.load[${JSON.stringify(name)}] = () => import("fixture:${name}");`,
      )
      .join("\n"),
  );
  const outDir = local("dist");
  // Exercise hints independently of the previous measured boot grouping.
  const { chunks, html } = await buildFixture(
    root,
    outDir,
    sources,
    aliases,
    [],
    createControlUiCodeSplitting({ includeBootGroups: false }),
  );
  const chunkFor = (id: string) => {
    const chunk = chunks.find((output) => id in output.modules);
    return chunk!;
  };
  const commonChunks = [entries.online, commonDependency].map((id) => chunkFor(id).fileName);
  const signerChunk = chunkFor(entries.signer).fileName;
  const chatChunk = chunkFor(entries.chat).fileName;
  const placementChunks = [entries.placement, placementDependency].map(
    (id) => chunkFor(id).fileName,
  );
  const chatPreloads = routePreloads(html, "chat");
  expect(chatPreloads.toSorted()).toEqual(
    [...new Set([signerChunk, chatChunk, ...commonChunks])].toSorted(),
  );
  expect(routePreloads(html, "new").toSorted()).toEqual(
    [...new Set([signerChunk, ...commonChunks, ...placementChunks])].toSorted(),
  );
  expect(chatPreloads[0]).toBe(signerChunk);
  expect(chatPreloads.indexOf(chatChunk)).toBeLessThan(
    chatPreloads.indexOf(chunkFor(entries.online).fileName),
  );
  const links = [...html.matchAll(/<link[^>]+>/gu)].map((match) => match[0]);
  const linkFor = (file: string) => links.find((link) => link.includes(`href="./${file}"`));
  expect(linkFor(chunkFor(entries.online).fileName)).toContain('fetchpriority="low"');
  expect(linkFor(chunkFor(entries.online).fileName)).toContain('rel="preload" as="script"');
  expect(linkFor(chunkFor(entries.online).fileName)).toContain("crossorigin");
  expect(linkFor(chatChunk)).toContain('rel="modulepreload"');
  expect(linkFor(chunkFor(commonDependency).fileName)).not.toContain("fetchpriority");
  expect(linkFor(signerChunk)).not.toContain("fetchpriority");
  expect(html).not.toContain(chunkFor(signingFallback).fileName);
  expect(html.split('<template data-openclaw-route-preloads="chat">')[0]).not.toContain(
    signerChunk,
  );
  expect(html).not.toContain(chunkFor(entries.creator).fileName);
  expect(html).not.toContain(chunkFor(entries.catalog).fileName);

  const fixture: {
    events: string[];
    load: Record<string, () => Promise<{ value: string }>>;
  } = { events: [], load: {} };
  vi.stubGlobal("preloadBuildFixture", fixture);
  const entry = chunks.find((chunk) => chunk.isEntry);
  await import(/* @vite-ignore */ pathToFileURL(path.join(outDir, entry!.fileName)).href);
  expect(fixture.events).toEqual([]);
  expect((await fixture.load.online!()).value).toBe("common");
  expect(fixture.events).toEqual(["common", "online"]);
  expect((await fixture.load.placement!()).value).toBe("placement");
  expect(fixture.events).toEqual(["common", "online", "placement-dependency", "placement"]);
});
