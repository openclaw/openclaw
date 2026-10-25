// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { controlUiBootPreloadsPlugin } from "../../config/control-ui-boot-preloads.ts";
import {
  controlUiCodeSplitting,
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

it.each([false, true])(
  "keeps desktop lazy and prioritizes the composer: %s",
  async (hasComposer) => {
    const root = tempDirs.make("control-ui-isolated-desktop-");
    const local = (name: string) => path.join(root, name);
    const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url));
    const desktop = local("desktop.js");
    const sidebar = modulePath("../components/app-sidebar.tsx");
    const outbox = modulePath("../lib/chat/outbox-store-projection.ts");
    const chat = modulePath("../pages/chat/route-loader.ts");
    const composer = modulePath("../pages/chat/components/chat-composer.tsx");
    // Real manifest entry IDs and payloads above the production group's minimum size.
    const sidebarValue = "sidebar-value-".repeat(12_000);
    const outboxValue = "outbox-value-".repeat(12_000);
    const chatValue = "chat-value-".repeat(50_000);
    const sources: Record<string, string> = {
      [sidebar]: `globalThis.desktopBuildFixture.events.push("sidebar"); export const value = ${JSON.stringify(sidebarValue)};`,
      [outbox]: `globalThis.desktopBuildFixture.events.push("outbox"); export const value = ${JSON.stringify(outboxValue)};`,
      [chat]: `${hasComposer ? 'import "fixture:composer";' : ""} globalThis.desktopBuildFixture.events.push("chat"); export const value = ${JSON.stringify(chatValue)};`,
      [composer]: 'globalThis.desktopBuildFixture.events.push("composer");',
    };
    const files = {
      "package.json": '{"type":"module"}',
      "index.html":
        '<html><head></head><body><script type="module" src="./main.js"></script></body></html>',
      "main.js": `globalThis.desktopBuildFixture.loadSidebar = () => import("fixture:sidebar");
       globalThis.desktopBuildFixture.loadOutbox = () => import("fixture:outbox");
       globalThis.desktopBuildFixture.loadChat = () => import("fixture:chat");
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
    };
    const buildFixture = async (isolated: boolean) => {
      const outDir = local(isolated ? "isolated" : "original");
      const result = await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: "silent",
        plugins: [
          {
            name: "desktop-build-fixture",
            enforce: "pre",
            resolveId: (source) => (Object.hasOwn(aliases, source) ? aliases[source] : null),
            load: (id) => (Object.hasOwn(sources, id) ? sources[id] : null),
          },
          ...(isolated ? [controlUiIsolatedDesktopRuntimePlugin()] : []),
          controlUiBootPreloadsPlugin(),
        ],
        build: {
          outDir,
          minify: false,
          target: "esnext",
          modulePreload: false,
          rolldownOptions: {
            output: {
              strictExecutionOrder: true,
              codeSplitting: controlUiCodeSplitting,
            },
          },
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
    };

    const original = await buildFixture(false);
    const isolated = await buildFixture(true);
    const shared = isolated.chunks.find(
      (chunk) => sidebar in chunk.modules && outbox in chunk.modules,
    );
    expect(shared).toBeDefined();
    const chatChunk = isolated.chunks.find((chunk) => chat in chunk.modules);
    expect(chatChunk).toBeDefined();
    for (const route of ["chat", "new"] as const) {
      const before = routePreloads(original.html, route);
      const after = routePreloads(isolated.html, route);
      expect(after).toEqual(
        expect.arrayContaining(
          route === "chat" ? [shared!.fileName, chatChunk!.fileName] : [shared!.fileName],
        ),
      );
      expect(after).toHaveLength(route === "chat" ? 2 : 1);
      expect(before.length).toBeGreaterThan(after.length);
      const routeHints = new RegExp(
        `<template data-openclaw-route-preloads="${route}">([\\s\\S]*?)</template>`,
        "u",
      ).exec(isolated.html)?.[1];
      const hints = routeHints?.match(/<link[^>]*>/gu) ?? [];
      expect(hints.find((hint) => hint.includes(shared!.fileName))).not.toContain(
        'fetchpriority="low"',
      );
      if (route === "chat") {
        const chatHint = hints.find((hint) => hint.includes(chatChunk!.fileName));
        expect(chatHint).toBeDefined();
        expect(chatHint?.includes('fetchpriority="low"')).toBe(!hasComposer);
      } else {
        expect(routeHints).not.toContain('fetchpriority="low"');
      }
    }
    const desktopChunk = isolated.chunks.find((chunk) => chunk.exports.includes("default"));
    expect(desktopChunk).toBeDefined();
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
    expect(entry).toBeDefined();
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
