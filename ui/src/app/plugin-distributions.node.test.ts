// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build, loadConfigFromFile, type Plugin } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlUiPluginDistributionsPlugin } from "../../config/control-ui-plugin-distributions.ts";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-distribution-build-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

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
  await fs.mkdir(path.join(pluginRoot, generation), { recursive: true });
  for (const [name, body] of files) {
    await fs.writeFile(path.join(pluginRoot, generation, name), body);
  }
  await fs.writeFile(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({ name: "@openclaw/workboard", version: "1.0.0" }),
  );
  await fs.writeFile(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: "  workboard  ",
      configSchema: { type: "object" },
      uiCapabilities: ["page", "page"],
      controlUi: { entry: `${generation}/index.js`, styles: [`${generation}/index.css`] },
    }),
  );
  const inventory = path.join(root, "ui/src/plugins/control-ui-distribution.ts");
  await fs.mkdir(path.dirname(inventory), { recursive: true });
  await fs.writeFile(inventory, "export const controlUiPluginDistributions = [];");
  await fs.writeFile(
    path.join(root, "index.html"),
    '<script type="module" src="./main.js"></script>',
  );
  await fs.writeFile(
    path.join(root, "main.js"),
    'import { controlUiPluginDistributions } from "./ui/src/plugins/control-ui-distribution.ts"; globalThis.distributions = controlUiPluginDistributions;',
  );
  return { files, generation, pluginRoot };
}

async function compile(inputs: Set<string>) {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
  );
  if (!loaded) {
    throw new Error("Control UI Vite configuration was not loaded");
  }
  const config = loaded.config;
  return build({
    ...config,
    root,
    build: { ...config.build, outDir: path.join(root, "ui-output") },
    configFile: false,
    publicDir: false,
    logLevel: "silent",
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
  const output = path.join(root, "ui-output/assets/plugins/workboard");
  const revisions = await fs.readdir(output);
  // The inventory must retain the existing catalog's declaration/capability/byte hash.
  expect(revisions).toEqual(["c81749b6c5f6b8233fad01698a3bfa483e5b27dbc540f8d1a4d3117bf05e1b75"]);
  for (const [name, body] of files) {
    const target = path.join(output, revisions[0]!, name);
    expect(await fs.readFile(target, "utf8")).toBe(body);
    expect(brotliDecompressSync(await fs.readFile(`${target}.br`)).toString()).toBe(body);
    expect(gunzipSync(await fs.readFile(`${target}.gz`)).toString()).toBe(body);
    expect(inputs.has(path.join(pluginRoot, generation, name))).toBe(true);
  }
  expect(inputs.has(path.join(pluginRoot, "package.json"))).toBe(true);
  expect(inputs.has(path.join(pluginRoot, "openclaw.plugin.json"))).toBe(true);
  const bundles = await fs.readdir(path.join(root, "ui-output/assets"));
  const source = (
    await Promise.all(
      bundles
        .filter((name) => name.endsWith(".js"))
        .map((name) => fs.readFile(path.join(root, "ui-output/assets", name), "utf8")),
    )
  ).join("\n");
  expect(source).toContain("@openclaw/workboard");
  expect(source).toContain(revisions[0]);
  expect(source).not.toContain("ROLLUP_FILE_URL");
  expect(source).toContain("import.meta.url");
});

it.each(["missing", "changed"])("rejects a generation with a %s deferred chunk", async (kind) => {
  const { pluginRoot, generation } = await fixture();
  const chunk = path.join(pluginRoot, generation, "chunk-1.js");
  if (kind === "missing") {
    await fs.rm(chunk);
  } else {
    await fs.writeFile(chunk, "export const message = 'Changed Workboard';");
  }
  await expect(compile(new Set()).then(() => undefined)).rejects.toThrow(
    /generation|assets|incomplete/iu,
  );
});

it("keeps standalone UI builds without packaged plugins available", async () => {
  await fixture();
  await fs.rm(path.join(root, "dist"), { recursive: true });
  await expect(compile(new Set())).resolves.toBeDefined();
  await expect(fs.stat(path.join(root, "ui-output/assets/plugins"))).rejects.toThrow();
});

it("rejects a full build whose promised packaged plugin is absent", async () => {
  await fixture();
  const source = path.join(root, "extensions/workboard");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "@openclaw/workboard",
      openclaw: { extensions: ["./index.ts"], controlUi: "./browser.ts" },
    }),
  );
  await fs.writeFile(
    path.join(source, "openclaw.plugin.json"),
    JSON.stringify({ id: "workboard" }),
  );
  await fs.writeFile(path.join(source, "index.ts"), "export default {};");
  await fs.rm(path.join(root, "dist"), { recursive: true });
  vi.stubEnv("OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS", "1");
  await expect(compile(new Set()).then(() => undefined)).rejects.toThrow(
    "Missing packaged native UI assets for workboard",
  );
});
