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
  const desktop = path.join(root, "desktop.js");
  const catalog = fileURLToPath(
    new URL("../components/app-sidebar-session-catalog-render.ts", import.meta.url),
  );
  const outbox = fileURLToPath(new URL("../lib/chat/outbox-store-projection.ts", import.meta.url));
  // Real manifest entry IDs and payloads above the production group's minimum size.
  const catalogValue = "catalog-value-".repeat(1500);
  const outboxValue = "outbox-value-".repeat(1500);
  const sources = new Map([
    [
      catalog,
      `globalThis.desktopBuildFixture.events.push("catalog"); export const value = ${JSON.stringify(catalogValue)};`,
    ],
    [
      outbox,
      `globalThis.desktopBuildFixture.events.push("outbox"); export const value = ${JSON.stringify(outboxValue)};`,
    ],
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, "package.json"), '{"type":"module"}'),
    fs.writeFile(
      path.join(root, "index.html"),
      '<html><head></head><body><script type="module" src="./main.js"></script></body></html>',
    ),
    fs.writeFile(
      path.join(root, "main.js"),
      `globalThis.desktopBuildFixture.loadCatalog = () => import("fixture:catalog");
       globalThis.desktopBuildFixture.loadOutbox = () => import("fixture:outbox");
       globalThis.desktopBuildFixture.loadDesktop = () => import("@novnc/novnc");`,
    ),
    fs.writeFile(
      desktop,
      `globalThis.desktopBuildFixture.events.push("desktop");
       globalThis.desktopBuildFixture.entered();
       const codec = await globalThis.desktopBuildFixture.codecReady;
       export default class RemoteDesktop { static codec = codec; }`,
    ),
  ]);

  const buildFixture = async (isolated: boolean) => {
    const outDir = path.join(root, isolated ? "isolated" : "original");
    const result = await build({
      configFile: false,
      root,
      publicDir: false,
      logLevel: "silent",
      plugins: [
        {
          name: "desktop-build-fixture",
          enforce: "pre",
          resolveId(source) {
            if (source === "@novnc/novnc") {
              return desktop;
            }
            if (source === "fixture:catalog") {
              return catalog;
            }
            return source === "fixture:outbox" ? outbox : null;
          },
          load: (id) => sources.get(id) ?? null,
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
    (chunk) => catalog in chunk.modules && outbox in chunk.modules,
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
  const notLoaded = async (): Promise<never> => {
    throw new Error("Fixture entry has not loaded");
  };
  const fixture: {
    events: string[];
    entered: () => void;
    codecReady: Promise<string>;
    loadCatalog: () => Promise<{ value: string }>;
    loadOutbox: () => Promise<{ value: string }>;
    loadDesktop: () => Promise<{ default: { codec: string } }>;
  } = {
    events: [],
    entered: entered.resolve,
    codecReady: codec.promise,
    loadCatalog: notLoaded,
    loadOutbox: notLoaded,
    loadDesktop: notLoaded,
  };
  vi.stubGlobal("desktopBuildFixture", fixture);
  const entry = isolated.chunks.find((chunk) => chunk.isEntry);
  expect(entry).toBeDefined();
  await import(/* @vite-ignore */ pathToFileURL(path.join(isolated.outDir, entry!.fileName)).href);
  expect(fixture.events).toEqual([]);
  await expect(fixture.loadCatalog()).resolves.toMatchObject({ value: catalogValue });
  expect(fixture.events).toEqual(["catalog"]);
  await expect(fixture.loadOutbox()).resolves.toMatchObject({ value: outboxValue });
  expect(fixture.events).toEqual(["catalog", "outbox"]);

  let resolved = false;
  const loadingDesktop = fixture.loadDesktop().then((module) => {
    resolved = true;
    return module;
  });
  try {
    await Promise.race([entered.promise, loadingDesktop]);
    expect(fixture.events).toEqual(["catalog", "outbox", "desktop"]);
    expect(resolved).toBe(false);
  } finally {
    codec.resolve("h264");
  }
  expect((await loadingDesktop).default.codec).toBe("h264");
});
