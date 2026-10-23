// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build, createServer, type Plugin } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlUiPluginDistributionsPlugin } from "../../config/control-ui-plugin-distributions.ts";
import controlUiViteConfig from "../../vite.config.ts";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-distribution-build-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
const at = (...parts: string[]) => path.join(root, ...parts);
const revision = "c81749b6c5f6b8233fad01698a3bfa483e5b27dbc540f8d1a4d3117bf05e1b75";
const viteOptions = {
  configFile: false as const,
  publicDir: false as const,
  logLevel: "silent" as const,
};

async function writeFiles(directory: string, files: Record<string, string | object>) {
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
  }
}

async function sourcePlugin(id: string, manifest: object, browser?: string) {
  await writeFiles(at("extensions", id), {
    "package.json": {
      name: `@openclaw/${id}`,
      ...(browser ? { version: "1.0.0", type: "module" } : {}),
      openclaw: { extensions: ["./index.ts"], controlUi: "./browser.ts" },
    },
    "openclaw.plugin.json": manifest,
    "index.ts": "export default {};",
    ...(browser ? { "browser.ts": browser } : {}),
  });
}

async function fixture() {
  const files = [
    ["chunk-1.js", "export const message = 'Deferred Workboard';"],
    ["index.css", ".workboard { color: green; }"],
    ["index.js", "export default { id: 'workboard', load: () => import('./chunk-1.js') };"],
  ] as const;
  const hash = createHash("sha256");
  for (const [name, body] of files) {
    hash.update(`${name}\0${Buffer.byteLength(body)}\0`).update(body);
  }
  const generation = `dist/control-ui/${hash.digest("hex")}`;
  const pluginRoot = path.join(root, "dist/extensions/workboard");
  await writeFiles(pluginRoot, {
    ...Object.fromEntries(files.map(([name, body]) => [`${generation}/${name}`, body])),
    "package.json": { name: "@openclaw/workboard", version: "1.0.0" },
    "openclaw.plugin.json": {
      id: "  workboard  ",
      configSchema: { type: "object" },
      uiCapabilities: ["page", "page"],
      controlUi: { entry: `${generation}/index.js`, styles: [`${generation}/index.css`] },
    },
  });
  await writeFiles(root, {
    "ui/src/plugins/control-ui-distribution.ts": "export const controlUiPluginDistributions = [];",
    "index.html": '<script type="module" src="./main.js"></script>',
    "main.js":
      'import { controlUiPluginDistributions } from "./ui/src/plugins/control-ui-distribution.ts"; globalThis.distributions = controlUiPluginDistributions;',
  });
  return { files, generation, pluginRoot };
}

async function compile(inputs = new Set<string>()) {
  const config = controlUiViteConfig({ command: "build" });
  return build({
    ...config,
    root,
    ...viteOptions,
    build: { ...config.build, outDir: at("ui-output") },
    plugins: (config.plugins as Plugin[]).map((plugin) =>
      plugin.name === "control-ui-plugin-distributions"
        ? controlUiPluginDistributionsPlugin(root, inputs)
        : plugin,
    ),
  });
}

it("publishes the complete immutable generation, its local inventory and matching compressed bytes", async () => {
  const { files, pluginRoot, generation } = await fixture();
  const inputs = new Set<string>();
  await compile(inputs);
  const output = at("ui-output/assets/plugins/workboard");
  const revisions = await fs.readdir(output);
  // The inventory must retain the existing catalog's declaration/capability/byte hash.
  expect(revisions).toEqual([revision]);
  for (const [name, body] of files) {
    const target = path.join(output, revisions[0]!, name);
    expect(await readText(target)).toBe(body);
    expect(brotliDecompressSync(await fs.readFile(`${target}.br`)).toString()).toBe(body);
    expect(gunzipSync(await fs.readFile(`${target}.gz`)).toString()).toBe(body);
    expect(inputs.has(path.join(pluginRoot, generation, name))).toBe(true);
  }
  expect(inputs.has(path.join(pluginRoot, "package.json"))).toBe(true);
  expect(inputs.has(path.join(pluginRoot, "openclaw.plugin.json"))).toBe(true);
  const assets = at("ui-output/assets");
  const source = (
    await Promise.all(
      (await fs.readdir(assets))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readText(assets, name)),
    )
  ).join("\n");
  expect(source).toContain("@openclaw/workboard");
  expect(source).toContain(revisions[0]);
  expect(source).toContain("import.meta.url");
  expect(source).not.toContain("ROLLUP_FILE_URL");
});

it.each(["missing", "changed"])("rejects a generation with a %s deferred chunk", async (kind) => {
  const { pluginRoot, generation } = await fixture();
  const chunk = path.join(pluginRoot, generation, "chunk-1.js");
  if (kind === "missing") {
    await fs.rm(chunk);
  } else {
    await fs.writeFile(chunk, "export const message = 'Changed Workboard';");
  }
  await expect(compile()).rejects.toThrow(/generation|assets|incomplete/iu);
});

it("keeps standalone UI builds without packaged plugins available", async () => {
  await fixture();
  await fs.rm(at("dist"), { recursive: true });
  await expect(compile()).resolves.toBeDefined();
  await expect(fs.stat(at("ui-output/assets/plugins"))).rejects.toThrow();
});

it("rejects a full build whose promised packaged plugin is absent", async () => {
  await fixture();
  await writeFiles(root, { "package.json": { name: "openclaw" } });
  await sourcePlugin("workboard", { id: "workboard" });
  await fs.rm(at("dist"), { recursive: true });
  vi.stubEnv("OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS", "1");
  await expect(compile()).rejects.toThrow("Missing packaged native UI assets for workboard");
});

it("serves the same validated generation and inventory from the development server", async () => {
  const { files } = await fixture();
  const server = await createServer({
    root,
    ...viteOptions,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [controlUiPluginDistributionsPlugin(root, new Set())],
  });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0]!;
    const inventory = await (
      await fetch(new URL("ui/src/plugins/control-ui-distribution.ts", url))
    ).text();
    const prefix = inventory.match(/\/assets\/plugins\/workboard\/[a-f0-9]{64}\//u)?.[0];
    expect(prefix).toBe(`/assets/plugins/workboard/${revision}/`);
    for (const [name, body] of files) {
      const response = await fetch(new URL(`${prefix}${name}`, url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        name.endsWith(".css") ? "text/css" : "javascript",
      );
      expect(await response.text()).toBe(body);
    }
  } finally {
    await server.close();
  }
});

it.each([
  { section: "memory", panel: "overview" },
  { section: "channels", panel: "detail", channelId: "custom" },
])(
  "builds source Settings assets while preserving sibling distributions (%s)",
  async (placement) => {
    vi.stubEnv("OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS", "1");
    const { pluginRoot, files, generation } = await fixture();
    const settingsRoot = at("extensions/settings-fixture");
    await writeFiles(at("extensions/manifest-only"), {
      "openclaw.plugin.json": { id: "manifest-only" },
    });
    await fs.symlink(path.resolve("node_modules"), at("node_modules"), "junction");
    await writeFiles(root, {
      "package.json": {
        name: "openclaw",
        type: "module",
        ...(placement.section === "channels"
          ? { files: ["!dist/extensions/settings-fixture/**"] }
          : {}),
      },
    });
    const manifest = {
      id: "settings-fixture",
      ...(placement.section === "channels" ? { channels: [placement.channelId] } : {}),
      controlUi: {
        activation: "settings-only",
        entry: "dist/control-ui/source/index.js",
        settingsViews: [placement],
      },
    };
    await sourcePlugin(
      "settings-fixture",
      manifest,
      'export default { pluginId: "settings-fixture", settingsViews: [] };\n',
    );
    await compile();
    const packaged = JSON.parse(
      await readText(at("dist/extensions/settings-fixture/openclaw.plugin.json")),
    );
    expect(packaged.controlUi.settingsViews).toEqual([placement]);
    expect(packaged.controlUi.activation).toBe("settings-only");
    expect(await fs.readdir(at("ui-output/assets/plugins/settings-fixture"))).toHaveLength(1);
    expect(await readText(settingsRoot, "openclaw.plugin.json")).toBe(JSON.stringify(manifest));
    for (const [name, body] of files) {
      expect(await readText(pluginRoot, generation, name)).toBe(body);
    }
    expect(JSON.parse(await readText(pluginRoot, "package.json")).name).toBe("@openclaw/workboard");
  },
);
