// @vitest-environment node
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build, createLogger, type InlineConfig, type Plugin } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listDirectoryTreeStrict,
  listDirectoryTreeStrictSync,
} from "../../../src/infra/directory-walk.js";
import { controlUiCodeSplitting } from "../../config/control-ui-chunking.ts";
import { controlUiPluginDistributionsPlugin } from "../../config/control-ui-plugin-distributions.ts";
import controlUiViteConfig from "../../vite.config.ts";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";

function readBuiltIdentity(html: string): { buildId: string } {
  const encoded = /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(.*?);<\/script>/u.exec(html)?.[1];
  assert.ok(encoded, "built document must carry its artifact identity");
  return JSON.parse(encoded);
}

const uiPath = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));
let root: string;
let outDir: string;
const info = vi.fn<(message: string) => void>();
const writeRoot = (file: string, source: string) => fs.writeFile(path.join(root, file), source);
const writeFiles = (files: Record<string, string>) =>
  Promise.all(Object.entries(files).map(([file, source]) => writeRoot(file, source)));
const readOutput = (file: string) => fs.readFile(path.join(outDir, file), "utf8");
const readAsset = (file: string) => readOutput(`assets/${file}`);
const assetNames = () => fs.readdir(path.join(outDir, "assets"));
const readBytes = (file: string) => fs.readFile(path.join(outDir, "assets", file));
function setOutput(
  config: InlineConfig,
  output: NonNullable<NonNullable<InlineConfig["build"]>["rolldownOptions"]>["output"],
) {
  config.build = { ...config.build, rolldownOptions: { ...config.build?.rolldownOptions, output } };
}
function offlineAssets(worker: string) {
  const boot: { assets: Array<{ path: string }> } = JSON.parse(
    /const OFFLINE_BOOT = (.+);/u.exec(worker)![1]!,
  );
  return boot.assets.map((asset) => asset.path);
}
const missingOutput = (file: string) =>
  expect(fs.stat(path.join(outDir, file))).rejects.toMatchObject({ code: "ENOENT" });
const readAssets = async (names: string[], extension: string) =>
  Promise.all(
    names
      .filter((name) => name.endsWith(extension))
      .map(async (name) => ({
        name,
        source: await readAsset(name),
      })),
  );
function addModules(
  config: InlineConfig,
  modules: Map<string, string>,
  aliases?: Record<string, string>,
) {
  config.plugins = [
    {
      name: "build-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        const resolved = !aliases
          ? id
          : (aliases[id] ??
            (importer && id.startsWith(".") ? path.resolve(path.dirname(importer), id) : null));
        return resolved && modules.has(resolved) ? resolved : null;
      },
      load: (id) => modules.get(id) ?? null,
    },
    ...(config.plugins ?? []),
  ];
}
async function buildOutput(config: InlineConfig) {
  const built = await build(config);
  if (Array.isArray(built) || !("output" in built)) {
    throw new Error("Expected one production bundle");
  }
  return {
    output: built.output,
    names: await assetNames(),
    html: await readOutput("index.html"),
    worker: await readOutput("sw.js"),
  };
}

function createConfig(level: "info" | "silent" = "silent"): InlineConfig {
  info.mockReset();
  const config = controlUiViteConfig({
    outDir,
    buildInfo: normalizeControlUiBuildInfo({
      version: "1.0.0",
      commit: "a".repeat(40),
      dirty: false,
      release: process.env.OPENCLAW_CONTROL_UI_RELEASE_BUILD?.trim() === "1",
    }),
  });
  return {
    ...config,
    plugins: (config.plugins as Plugin[]).map((plugin) =>
      plugin.name === "control-ui-plugin-distributions"
        ? controlUiPluginDistributionsPlugin(root, new Set())
        : plugin,
    ),
    configFile: false,
    root,
    publicDir: false,
    logLevel: level,
    customLogger: createLogger(level, {
      allowClearScreen: false,
      console: { ...console, log: info, error: vi.fn() },
    }),
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "control-ui-vite-build-")));
  outDir = path.join(root, "dist");
  await writeFiles({
    "index.html":
      '<script>globalThis.fixtureBooted = true;</script><button>Load</button><script type="module" src="./main.js"></script>',
    "main.js": 'globalThis.load = () => import("./lazy.js");',
    "lazy.js": 'import "./lazy.css"; export const message = "Lazy content loaded";',
    "lazy.css": "body { color: green; }",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("omits already imported JavaScript from lazy preload tables, retaining lazy JS and CSS", async () => {
  const config = createConfig();
  await writeFiles({
    "main.js":
      'import { shared } from "./shared.js"; globalThis.shared = shared; globalThis.load = () => import("./lazy.js"); globalThis.loadPlain = () => import("./plain.js");',
    "shared.js": 'export const shared = "shared";',
    "lazy-only.js": 'export const lazy = "lazy-only";',
    "plain.js":
      'import { lazy } from "./lazy-only.js"; export const message = "No stylesheet wait" + lazy;',
    "lazy.js":
      'import { shared } from "./shared.js"; import { lazy } from "./lazy-only.js"; import "./lazy.css"; export const message = shared + lazy;',
  });
  setOutput(config, {
    codeSplitting: {
      groups: ["shared", "lazy-only"].map((name) => ({
        name,
        test: (id: string) => id === path.join(root, `${name}.js`),
      })),
    },
  });
  const { names, html } = await buildOutput(config);
  const entryName = names.find((name) => /^index-.*\.js$/u.test(name))!;
  const entry = await readAsset(entryName);
  const table = /^const __vite__mapDeps=.*$/mu.exec(entry)?.[0];
  const sharedName = names.find((name) => /^shared-.*\.js$/u.test(name))!;
  const lazyName = names.find((name) => /^lazy-only-.*\.js$/u.test(name))!;
  const plainName = names.find((name) => /^plain-.*\.js$/u.test(name))!;
  expect(entry).toContain(sharedName);
  expect(entry).toContain(plainName);
  expect(table).not.toContain(plainName);
  expect(table).not.toContain(sharedName);
  expect(table).toContain(lazyName);
  expect(table).toMatch(/lazy-[^"/]+\.css/u);
  expect(html).toContain(sharedName);
});

it("keeps page styles separate from measured JavaScript boot groups", async () => {
  const config = createConfig();
  const pages = fileURLToPath(new URL("../pages/", import.meta.url));
  const first = path.join(pages, "chunk-fixture-first", "view.ts");
  const second = path.join(pages, "chunk-fixture-second", "view.ts");
  const lazy = path.join(pages, "chunk-fixture-lazy", "view.ts");
  const firstCss = fileURLToPath(new URL("../styles/new-session.css", import.meta.url));
  const secondCss = fileURLToPath(new URL("../styles/chat/composer-progress.css", import.meta.url));
  const lazyCss = path.join(path.dirname(lazy), "view.css");
  const modules = new Map([
    [first, 'import "../../styles/new-session.css"; export const message = "first";'],
    [second, 'import "../../styles/chat/composer-progress.css"; export const message = "second";'],
    [lazy, 'import "./view.css"; export const message = "lazy";'],
    [firstCss, ".first-page { color: red; }"],
    [secondCss, ".second-page { color: blue; }"],
    [lazyCss, ".lazy-page { color: purple; }"],
  ]);
  await writeRoot("initial.css", ".initial-page { color: green; }");
  await writeRoot(
    "main.js",
    'import "./initial.css"; globalThis.loadFirst = () => import("fixture:first"); globalThis.loadSecond = () => import("fixture:second"); globalThis.loadLazy = () => import("fixture:lazy");',
  );
  addModules(config, modules, {
    "fixture:first": first,
    "fixture:second": second,
    "fixture:lazy": lazy,
  });
  setOutput(config, {
    strictExecutionOrder: true,
    codeSplitting: {
      ...controlUiCodeSplitting,
      groups: controlUiCodeSplitting.groups.map((group) =>
        group.name === "control-ui-boot-shared"
          ? Object.assign({}, group, {
              test: (id: string) => [first, second, firstCss, secondCss].includes(id),
              minSize: 0,
            })
          : group,
      ),
    },
  });
  const built = await buildOutput(config);
  const lazyChunk = built.output.find((chunk) => chunk.type === "chunk" && lazy in chunk.modules);
  expect(lazyChunk?.type === "chunk" && lazyCss in lazyChunk.modules).toBe(true);
  const { names, html } = built;
  const styles = await readAssets(names, ".css");
  const initial = styles.find(({ source }) => source.includes(".initial-page"))!;
  const firstStyle = styles.find(({ source }) => source.includes(".first-page"))!;
  const secondStyle = styles.find(({ source }) => source.includes(".second-page"))!;
  expect(new Set([initial.name, firstStyle.name, secondStyle.name]).size).toBe(3);
  expect(html).toContain(initial.name);
  expect(html).toMatch(/<link[^>]*rel="preload"[^>]*as="style"[^>]*>/u);
  expect(html).toMatch(/<link[^>]*id="openclaw-boot-styles"[^>]*media="print"[^>]*>/u);
  expect(html).not.toContain(firstStyle.name);
  expect(html).not.toContain(secondStyle.name);
  const scripts = (await readAssets(names, ".js")).map(({ source }) => source).join("\n");
  expect(scripts).toContain(firstStyle.name);
  expect(scripts).toContain(secondStyle.name);
});

it.each(["login", "attachment"] as const)(
  "prepares %s assets offline without preloading the wrong modules",
  async (kind) => {
    const attachment = kind === "attachment";
    const entry = uiPath(
      attachment ? "components/app-sidebar.tsx" : "components/login-gate-solid.tsx",
    );
    const dependency = attachment
      ? path.join(root, "resize.js")
      : uiPath("components/login-offline-fixture.ts");
    const modules = new Map<string, string>();
    if (attachment) {
      await fs.writeFile(dependency, 'self.onmessage = () => self.postMessage("resized");');
      modules.set(
        entry,
        `import url from ${JSON.stringify(`${dependency}?worker&url`)}; export const resize = () => new Worker(url);`,
      );
    } else {
      modules.set(
        entry,
        `import { message } from ${JSON.stringify(dependency)}; export const label = message;`,
      );
      modules.set(dependency, 'export const message = "Connect again when online";');
    }
    const config = createConfig();
    await writeRoot("main.js", `globalThis.load = () => import(${JSON.stringify(entry)});`);
    addModules(config, modules);
    const built = await buildOutput(config);
    const chunk = built.output.find(
      (item) => item.type === "chunk" && item.facadeModuleId === entry,
    );
    assert.ok(chunk?.type === "chunk", "Expected the dynamically imported fixture entry");
    const cached = offlineAssets(built.worker);
    if (attachment) {
      const workerFile = built.names.find((name) => /^resize-.*\.js$/u.test(name));
      expect(workerFile).toBeDefined();
      expect(cached).toContain(`assets/${workerFile}`);
      expect(built.html).toContain(chunk.fileName);
      expect(built.html).not.toContain(workerFile);
    } else {
      expect(cached).toEqual(expect.arrayContaining([chunk.fileName, ...chunk.imports]));
      expect(built.html).not.toContain(chunk.fileName);
    }
  },
);

it.each(["unresolved import", "blocked output"])(
  "preserves the original %s diagnostic without finalizing the build",
  async (failure) => {
    const config = createConfig("info");
    if (failure === "unresolved import") {
      await writeRoot("main.js", 'import "./missing-module.js";');
    } else {
      await fs.mkdir(outDir);
      await fs.writeFile(path.join(outDir, "blocked"), "output obstruction");
      config.build = { ...config.build, emptyOutDir: false, assetsDir: "blocked" };
    }
    const result = build(config);
    if (failure === "unresolved import") {
      await expect(result).rejects.toThrow(/Could not resolve.*missing-module\.js/u);
      await expect(result).rejects.not.toThrow(/ENOENT/u);
      await expect(fs.stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(result).rejects.toThrow(/blocked/u);
      await expect(result).rejects.not.toThrow(/scandir/u);
      expect(await readOutput("blocked")).toBe("output obstruction");
      await missingOutput("sw.js");
    }
    expect(info.mock.calls.flat().join("\n")).not.toMatch(/precompression complete|built in/u);
  },
);

it("finalizes raw browser-fixture assets when precompression is omitted", async () => {
  const config = createConfig();
  await writeRoot(
    "main.js",
    'import catalog from "virtual:openclaw-control-ui-locale/fr"; globalThis.catalog = catalog;',
  );
  config.plugins = config.plugins?.filter(
    (plugin) => !(plugin && "name" in plugin && plugin.name === "control-ui-precompressed-assets"),
  );

  const { names, html, worker } = await buildOutput(config);

  expect(names.some((name) => name.endsWith(".br") || name.endsWith(".gz"))).toBe(false);
  const entry = names.find((name) => /^index-.*\.js$/u.test(name));
  expect(entry).toBeDefined();
  expect(html).toContain(entry);
  const identity = readBuiltIdentity(html);
  expect(worker).toContain(`const EMBEDDED_CACHE_VERSION = "${identity.buildId}";`);
  expect(offlineAssets(worker)).toContain(`assets/${entry}`);
  expect(JSON.parse(await readOutput(".build-inputs.json"))).toEqual(
    expect.arrayContaining([
      "src/config/schema.hints.ts",
      "src/gateway/control-ui-csp.ts",
      "ui/src/app-route-paths.ts",
    ]),
  );
});

it("reports completed compression work before build completion at a bounded cadence", async () => {
  const config = createConfig("info");
  let clockMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs);
  const writeFileSync = fsSync.writeFileSync;
  vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, ...args) => {
    writeFileSync(file, ...args);
    if (String(file).endsWith(".br") || String(file).endsWith(".gz")) {
      clockMs += 2_500;
    }
  });
  const activity: Array<{ message: string; elapsed: number; assets: number; sidecars: number }> =
    [];
  info.mockImplementation((message: string) => {
    if (!message.includes("Control UI precompression")) {
      return;
    }
    const emitted = listDirectoryTreeStrictSync(path.join(outDir, "assets")).map(
      (walkEntry) => walkEntry.relativePath,
    );
    activity.push({
      message,
      elapsed: clockMs,
      assets: new Set(
        emitted.filter((name) => /\.(br|gz)$/u.test(name)).map((name) => name.slice(0, -3)),
      ).size,
      sidecars: emitted.filter((name) => /\.(br|gz)$/u.test(name)).length,
    });
    // The logger observes real disk writes while build() is still finalizing.
    expect(fsSync.existsSync(path.join(outDir, "sw.js"))).toBe(false);
  });
  config.plugins = [
    ...(config.plugins ?? []),
    {
      name: "compression-progress-fixture",
      generateBundle() {
        for (let index = 0; index < 4; index++) {
          this.emitFile({
            type: "asset",
            fileName: `assets/x/${index}.txt`,
            source: "fixture".repeat(1024),
          });
        }
      },
    },
  ];

  await build(config);

  const emitted = (await listDirectoryTreeStrict(path.join(outDir, "assets"))).map(
    (walkEntry) => walkEntry.relativePath,
  );
  const sidecars = emitted.filter((name) => /\.(br|gz)$/u.test(name));
  const completed = new Set(sidecars.map((name) => name.slice(0, -3))).size;
  expect(completed).toBeGreaterThan(4);
  expect(activity[0]).toMatchObject({ elapsed: 0, assets: 0, sidecars: 0 });
  expect(activity.at(-1)).toMatchObject({
    elapsed: sidecars.length * 2_500,
    assets: completed,
    sidecars: sidecars.length,
  });
  expect(activity.length).toBeGreaterThan(2);
  for (let index = 1; index < activity.length - 1; index++) {
    const elapsed = activity[index]!.elapsed - activity[index - 1]!.elapsed;
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
    // One completed asset can cross the reporting interval by one sidecar write.
    expect(elapsed).toBeLessThanOrEqual(12_500);
  }
  expect(activity[0]?.message).toMatch(/starting/u);
  for (const entry of activity.slice(1)) {
    expect(entry.message).toContain(`${entry.assets} assets (${entry.sidecars} sidecars)`);
  }
  expect(activity.at(-1)?.message).toContain("precompression complete");
  await expect(fs.stat(path.join(outDir, "sw.js"))).resolves.toBeDefined();
});

it.each([
  { output: "configured", release: false },
  { output: "absolute override", release: true },
  { output: "relative override", release: false },
  { output: "output override", release: true },
])("finalizes $output assets and maps (release=$release)", async ({ output, release }) => {
  vi.stubEnv("OPENCLAW_CONTROL_UI_RELEASE_BUILD", release ? "1" : undefined);
  const config = createConfig();
  const configuredOutDir = outDir;
  if (output !== "configured") {
    outDir = path.join(root, "overridden-output");
    if (output === "output override") {
      setOutput(config, { dir: outDir });
    } else {
      config.build = {
        ...config.build,
        outDir: output === "relative override" ? path.relative(root, outDir) : outDir,
      };
    }
  }
  config.publicDir = fileURLToPath(new URL("../../public", import.meta.url));
  await writeRoot(
    "index.html",
    '<html><body><script>globalThis.fixtureBooted = true;</script><button>Load</button><script type="module" src="./main.js"></script></body></html>',
  );
  const { names: emitted, html, worker } = await buildOutput(config);
  expect(info).not.toHaveBeenCalled();
  if (output !== "configured") {
    await expect(fs.stat(configuredOutDir)).rejects.toMatchObject({ code: "ENOENT" });
  }

  const entry = emitted.find((name) => /^index-.*\.js$/u.test(name))!;
  const entryBytes = await readBytes(entry);
  for (const encoding of ["br", "gz"]) {
    const compressed = await readBytes(`${entry}.${encoding}`);
    expect(encoding === "br" ? brotliDecompressSync(compressed) : gunzipSync(compressed)).toEqual(
      entryBytes,
    );
  }
  const scripts = emitted.filter((name) => name.endsWith(".js"));
  expect(scripts.some((name) => emitted.includes(`${name}.map`))).toBe(true);
  for (const name of scripts) {
    expect((await readAsset(name)).includes("sourceMappingURL="), name).toBe(
      !release && emitted.includes(`${name}.map`),
    );
  }
  const embeddedBuildId = /const EMBEDDED_CACHE_VERSION = "([^"]+)"/u.exec(worker)?.[1];
  const buildInfo = readBuiltIdentity(html);
  expect(embeddedBuildId).toBe(buildInfo.buildId);

  const scriptTags = html.match(/<script\b[^>]*>/gu) ?? [];
  expect(scriptTags.length).toBeGreaterThan(0);
  for (const tag of scriptTags) {
    expect(tag).toMatch(/^<script data-cfasync="false"(?:\s|>)/u);
  }
  const cacheId = /data-openclaw-control-ui-build-id="([^"]+)"/u.exec(html)?.[1];
  expect(cacheId?.startsWith(`${buildInfo.buildId}-`)).toBe(true);
  expect(cacheId?.slice(buildInfo.buildId.length + 1)).toMatch(/^[a-f0-9]{64}$/u);
  const fonts = await fs.readdir(path.join(outDir, "fonts"));
  for (const fontCss of fonts.filter((name) => name.endsWith(".css"))) {
    const source = await fs.readFile(path.join(outDir, "fonts", fontCss), "utf8");
    const references = [...source.matchAll(/url\("([^"]+)"\)/gu)];
    expect(references.length).toBeGreaterThan(0);
    for (const [, reference] of references) {
      const fontUrl = new URL(
        reference!,
        `https://control.example/ui/fonts/${fontCss}?v=${cacheId}`,
      );
      expect(fontUrl.searchParams.get("v")).toBe(cacheId);
      expect(fontUrl.pathname).toMatch(/^\/ui\/fonts\/[^/]+\.woff2$/u);
      await expect(
        fs.stat(path.join(outDir, fontUrl.pathname.slice("/ui/".length))),
      ).resolves.toBeDefined();
    }
  }
  const webManifest: { start_url: string; icons: Array<{ src: string }> } = JSON.parse(
    await readOutput("manifest.webmanifest"),
  );
  expect(webManifest.start_url).toBe("./");
  for (const icon of webManifest.icons) {
    const iconUrl = new URL(icon.src, "https://control.example/ui/manifest.webmanifest");
    expect(iconUrl.searchParams.get("v")).toBe(cacheId);
    await expect(
      fs.stat(path.join(outDir, iconUrl.pathname.slice("/ui/".length))),
    ).resolves.toBeDefined();
  }
});

it("changes the public asset version after a same-commit rebuild without changing worker identity", async () => {
  const config = createConfig();
  const publicDir = path.join(root, "public");
  await fs.mkdir(publicDir);
  config.publicDir = publicDir;
  await writeRoot("index.html", '<html><script type="module" src="./main.js"></script></html>');
  let initialBuildId: string | undefined;
  const cacheIds: string[] = [];
  for (const title of ["First", "Second"]) {
    await fs.writeFile(path.join(publicDir, "favicon.svg"), `<svg><title>${title}</title></svg>`);
    const { html, worker } = await buildOutput(config);
    initialBuildId ??= readBuiltIdentity(html).buildId;
    const cacheId = /data-openclaw-control-ui-build-id="([^"]+)"/u.exec(html)?.[1];
    expect(cacheId).toBeDefined();
    cacheIds.push(cacheId!);
    expect(/const EMBEDDED_CACHE_VERSION = "([^"]+)"/u.exec(worker)?.[1]).toBe(initialBuildId);
  }
  expect(cacheIds[0]).not.toBe(cacheIds[1]);
});

it("does not count an asset or report completion when its second sidecar write fails", async () => {
  const config = createConfig("info");
  const writeFileSync = fsSync.writeFileSync;
  vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, ...args) => {
    if (String(file).endsWith(".gz")) {
      throw new Error("synthetic gzip write failure");
    }
    writeFileSync(file, ...args);
  });

  await expect(build(config)).rejects.toThrow("synthetic gzip write failure");

  const output = info.mock.calls.flat().join("\n");
  expect(output).toContain("Control UI precompression: starting");
  expect(output).not.toMatch(/\d+ assets|precompression complete|built in/u);
  const emitted = await assetNames();
  const startedAssets = emitted.filter((name) => name.endsWith(".br")).length;
  expect(startedAssets).toBeGreaterThan(0);
  expect(startedAssets).toBeLessThanOrEqual(4);
  expect(emitted.filter((name) => name.endsWith(".gz"))).toHaveLength(0);
  await missingOutput("sw.js");
});
