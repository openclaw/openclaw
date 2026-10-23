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

it("keeps desktop codec detection lazy without adding boot facade requests", async () => {
  const root = tempDirs.make("control-ui-isolated-desktop-");
  const local = (name: string) => path.join(root, name);
  const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  const desktop = local("desktop.js");
  const sidebar = modulePath("../components/app-sidebar.tsx");
  const outbox = modulePath("../lib/chat/outbox-store-projection.ts");
  // Real manifest entry IDs and payloads above the production group's minimum size.
  const sidebarValue = "sidebar-value-".repeat(12_000);
  const outboxValue = "outbox-value-".repeat(12_000);
  const sources: Record<string, string> = {
    [sidebar]: `globalThis.desktopBuildFixture.events.push("sidebar"); export const value = ${JSON.stringify(sidebarValue)};`,
    [outbox]: `globalThis.desktopBuildFixture.events.push("outbox"); export const value = ${JSON.stringify(outboxValue)};`,
  };
  const files = {
    "package.json": '{"type":"module"}',
    "index.html":
      '<html><head></head><body><script type="module" src="./main.js"></script></body></html>',
    "main.js": `globalThis.desktopBuildFixture.loadSidebar = () => import("fixture:sidebar");
       globalThis.desktopBuildFixture.loadOutbox = () => import("fixture:outbox");
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
  for (const route of ["chat", "new"] as const) {
    const before = routePreloads(original.html, route);
    const after = routePreloads(isolated.html, route);
    expect(after).toEqual([shared!.fileName]);
    expect(before.length).toBeGreaterThan(after.length);
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
    loadDesktop: notLoaded<{ default: { codec: string } }>,
  };
  vi.stubGlobal("desktopBuildFixture", fixture);
  const entry = isolated.chunks.find((chunk) => chunk.isEntry);
  expect(entry).toBeDefined();
  await import(/* @vite-ignore */ pathToFileURL(path.join(isolated.outDir, entry!.fileName)).href);
  expect(fixture.events).toEqual([]);
  await expect(fixture.loadSidebar()).resolves.toMatchObject({ value: sidebarValue });
  expect(fixture.events).toEqual(["sidebar"]);
  await expect(fixture.loadOutbox()).resolves.toMatchObject({ value: outboxValue });
  expect(fixture.events).toEqual(["sidebar", "outbox"]);

  let resolved = false;
  const loadingDesktop = fixture.loadDesktop().then((module) => {
    resolved = true;
    return module;
  });
  try {
    await Promise.race([entered.promise, loadingDesktop]);
    expect(fixture.events).toEqual(["sidebar", "outbox", "desktop"]);
    expect(resolved).toBe(false);
  } finally {
    codec.resolve("h264");
  }
  expect((await loadingDesktop).default.codec).toBe("h264");
});
