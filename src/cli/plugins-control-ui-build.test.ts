import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  CONTROL_UI_PLUGIN_MAX_ASSETS,
  readPluginControlUiAssets,
} from "../plugins/control-ui-assets.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import { withEnvAsync } from "../test-utils/env.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import {
  createPluginImportFixture,
  unresolvedPluginImportCases,
} from "./plugins-build-bundle.test-support.js";
import { buildPluginControlUi, writePluginBuildManifest } from "./plugins-control-ui-build.js";

const directories: string[] = [];
const readText = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const readJson = async (root: string, file: string) => JSON.parse(await readText(root, file));
const write = (root: string, file: string, contents: string) =>
  fs.writeFile(path.join(root, file), contents);
const browserModule = (root: string, entry: string) =>
  import(pathToFileURL(path.join(root, entry)).href);

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await write(root, file, contents);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginCache();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  source = 'import "./style.css"; export const message = "first";\nexport async function loadDependencies(name: string) { return [(await import("./lazy.js")).value, (await import("./localized/" + name + ".js")).value]; }\n',
  files: Record<string, string> = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-build-"));
  directories.push(directory);
  await fs.mkdir(path.join(directory, "node_modules"));
  await fs.symlink(
    path.resolve("node_modules/esbuild"),
    path.join(directory, "node_modules/esbuild"),
    "dir",
  );
  await writeFiles(directory, {
    "package.json": JSON.stringify({ name: "ui-build-fixture", type: "module" }),
    "index.ts": source,
    "style.css": ".fixture { color: var(--text); }",
    "lazy.js": 'export const value = "literal dependency";',
    "localized/value.js": 'export const value = "glob dependency";',
    ...files,
  });
  const project = { rootDir: directory, source: "index.ts" };
  return {
    ...project,
    file: (name: string) => path.join(directory, name),
    read: (name: string) => readText(directory, name),
    write: (name: string, content: string) => write(directory, name, content),
    build: (check = false) => buildPluginControlUi({ ...project, check }),
    load: (entry: string) => browserModule(directory, entry),
  };
}

type Project = Awaited<ReturnType<typeof fixture>>;
async function publish(project: Project) {
  const first = await project.build();
  await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
  return first;
}

async function expectGenerations(project: Project, entry?: string) {
  const generations = fs.readdir(project.file("dist/control-ui"));
  if (entry) {
    await expect(generations).resolves.toEqual([path.basename(path.dirname(entry))]);
  } else {
    await expect(generations).rejects.toThrow("ENOENT");
  }
}

describe("plugin build manifest publication", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.skipIf(process.platform === "win32").each([{ mask: 0o002, expectedMode: 0o664 }])(
    "creates a manifest under isolated umask $mask",
    async ({ mask, expectedMode }) => {
      const rootDir = tempDirs.make("openclaw-build-manifest-");
      // umask is process-wide; keep it out of the shared Vitest worker.
      const stdout = execNodeEvalSync(
        `import fs from "node:fs/promises";
import { writePluginBuildManifest } from ${JSON.stringify(new URL("./plugins-control-ui-build.ts", import.meta.url).href)};
process.umask(${mask});
await writePluginBuildManifest(${JSON.stringify(rootDir)}, { id: "fixture" });
const manifest = ${JSON.stringify(path.join(rootDir, "openclaw.plugin.json"))};
console.log(JSON.stringify({ mode: (await fs.stat(manifest)).mode & 0o7777, content: await fs.readFile(manifest, "utf8") }));`,
        {
          imports: [new URL("../../scripts/tsx.mjs", import.meta.url).href],
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        mode: expectedMode,
        content: '{\n  "id": "fixture"\n}\n',
      });
      expect(await fs.readdir(rootDir)).toEqual(["openclaw.plugin.json"]);
    },
  );
});

describe("native plugin browser builds", () => {
  it.each([true, false, "settings-only", "channel-settings"])(
    "builds runtime browser artifacts without changing authored plugin metadata (authored UI: %s)",
    async (authoredUi) => {
      const project = await fixture();
      const packagePath = path.join(project.rootDir, "package.json");
      const packageJson = await readJson(project.rootDir, "package.json");
      packageJson.openclaw = { controlUi: project.source };
      await fs.writeFile(packagePath, JSON.stringify(packageJson));
      const manifestPath = path.join(project.rootDir, "openclaw.plugin.json");
      const settingsViews =
        authoredUi === "channel-settings"
          ? [{ section: "channels", panel: "detail", channelId: "custom" }]
          : authoredUi === "settings-only"
            ? [
                { section: "memory", panel: "overview" },
                { section: "memory", panel: "memories" },
              ]
            : undefined;
      const authored = {
        id: "fixture",
        ...(authoredUi === "channel-settings" ? { channels: ["custom"] } : {}),
        configSchema: { type: "object", properties: { token: { type: "string" } } },
        activation: { onStartup: true },
        ...(authoredUi
          ? {
              controlUi: {
                entry: "dist/control-ui/authored/index.js",
                ...(settingsViews
                  ? {
                      activation: "settings-only",
                      settingsViews,
                    }
                  : {}),
              },
            }
          : {}),
      };
      const original = JSON.stringify(authored, null, 2);
      await fs.writeFile(manifestPath, original);
      execFileSync(
        process.execPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          path.resolve("scripts/build-plugin-control-ui.mts"),
          project.rootDir,
        ],
        { timeout: 10_000 },
      );
      expect(await fs.readFile(manifestPath, "utf8")).toBe(original);
      const generatedPath = path.join(project.rootDir, "dist/openclaw.plugin.json");
      const generated = await readJson(project.rootDir, "dist/openclaw.plugin.json");
      expect(generated.controlUi.activation).toBe(settingsViews ? "settings-only" : undefined);
      expect(generated.controlUi.settingsViews).toEqual(settingsViews);
      expect(await buildPluginControlUi({ ...project, check: true })).toEqual(generated.controlUi);
      generated.id = "previous-name";
      generated.configSchema = { type: "object", properties: {} };
      generated.activation = { onStartup: false };
      await fs.writeFile(generatedPath, JSON.stringify(generated));
      const loaded = loadPluginManifest(project.rootDir);
      expect(loaded).toMatchObject({
        ok: true,
        manifest: { ...authored, controlUi: generated.controlUi },
      });
      const assets = await readPluginControlUiAssets(project.rootDir, generated.controlUi);
      expect(assets.entryName).toBe("index.js");
      const built = await browserModule(project.rootDir, generated.controlUi.entry);
      expect(built.message).toBe("first");
    },
  );

  it("preserves esbuild's existing non-Solid JSX compilation", async () => {
    const project = await fixture('export * from "./view.tsx";', {
      "renderer.js":
        "export const createElement = (tag, props, ...children) => ({ tag, props, children });",
      "view.tsx":
        'import * as React from "./renderer.js"; export const view = <p>Existing JSX</p>;',
    });
    const built = await project.load((await project.build()).entry);
    expect(built.view).toEqual({ tag: "p", props: null, children: ["Existing JSX"] });
  });

  it("bundles a Solid TSX view with reactive updates and owned disposal", async () => {
    const project = await fixture();
    const dependencies = project.file("node_modules");
    await fs.rm(dependencies, { recursive: true });
    await fs.mkdir(path.join(dependencies, "@solidjs"), { recursive: true });
    for (const name of ["esbuild", "solid-js", "@solidjs/web", "@solidjs/compiler"]) {
      const owner = name === "esbuild" ? "node_modules" : "ui/node_modules";
      await fs.symlink(path.resolve(owner, name), path.join(dependencies, name), "dir");
    }
    await project.write(
      "view.tsx",
      `/** @jsxImportSource @solidjs/web */
import { createSignal, flush, onCleanup } from "solid-js";
import { render } from "@solidjs/web";
export let cleanups = 0;
function View(props: { label: () => string; click: () => void }) {
  onCleanup(() => cleanups++);
  return <button onClick={props.click}>{props.label()}</button>;
}
export function mount(container: HTMLElement, context: { props: { label: string } }) {
  const [label, setLabel] = createSignal(context.props.label);
  const dispose = render(() => <View label={label} click={() => setLabel("clicked")} />, container);
  return {
    update(next: typeof context) { setLabel(next.props.label); },
    focus() { container.querySelector("button")?.focus(); },
    dispose,
  };
}
export { flush };
`,
    );
    // A plain TS entry must also discover TSX modules imported by the plugin.
    await project.write(project.source, 'export * from "./view.tsx";');
    const declaration = await project.build();
    const dom = new JSDOM("<body><main></main></body>");
    vi.stubGlobal("document", dom.window.document);
    try {
      const built = await project.load(declaration.entry);
      const container = dom.window.document.querySelector("main")!;
      const view = built.mount(container, { props: { label: "first" } });
      try {
        built.flush();
        const button = container.querySelector("button")!;
        expect(button.textContent).toBe("first");
        view.update({ props: { label: "updated" } });
        built.flush();
        expect(container.querySelector("button")).toBe(button);
        expect(button.textContent).toBe("updated");
        view.focus();
        expect(dom.window.document.activeElement).toBe(button);
        button.click();
        built.flush();
        expect(button.textContent).toBe("clicked");
      } finally {
        view.dispose();
      }
      expect(container.childNodes).toHaveLength(0);
      expect(built.cleanups).toBe(1);
    } finally {
      dom.window.close();
    }
  });

  it("requires the author-installed Solid compiler only for opted-in TSX", async () => {
    const project = await fixture();
    const first = await project.build();
    await writeFiles(project.rootDir, {
      "view.tsx": "/** @jsxImportSource @solidjs/web */\nexport const view = <p>Ready</p>;",
      [project.source]: 'export * from "./view.tsx";',
    });
    await expect(project.build()).rejects.toThrow(
      "Install @solidjs/compiler in this plugin's devDependencies",
    );
    await expectGenerations(project, first.entry);
  });

  it("removes unused dependency loaders without treating text as imports", async () => {
    const project = await fixture(
      '// import(anotherVariable)\nexport { message } from "./dependency.js";',
      {
        "dependency.js":
          'export const message = "import(variable)"; export const unused = (specifier) => import(specifier);',
      },
    );
    const built = await project.load((await project.build()).entry);
    expect(built.message).toBe("import(variable)");
  });

  it("rejects a retained computed import in a split output chunk", async () => {
    const project = await fixture('export const loadPage = () => import("./page.js");', {
      "page.js": "export const load = (specifier) => import(specifier);",
    });
    await expect(project.build()).rejects.toThrow("will not be bundled");
    await expectGenerations(project);
  });

  it.each([
    { name: "static import", source: 'export { value } from "https://example.invalid/plugin.js";' },
    {
      name: "literal dynamic import",
      source: 'export const load = () => import("https://example.invalid/plugin.js");',
    },
  ])("rejects a retained external $name", async ({ source }) => {
    const project = await fixture(source);
    await expect(project.build()).rejects.toThrow("must bundle their browser dependencies");
    await expectGenerations(project);
  });

  it("publishes complete immutable generations and detects stale source", async () => {
    const project = await fixture();
    const first = await publish(project);
    expect(first.entry).toMatch(/^dist\/control-ui\/[a-f0-9]{64}\/index.js$/u);
    expect(first.styles).toHaveLength(1);
    expect(await project.build()).toEqual(first);
    expect(await project.build(true)).toEqual(first);
    const generation = project.file(path.dirname(first.entry));
    const chunks = (await fs.readdir(generation)).filter((name) => name.startsWith("chunk-"));
    expect(chunks.length).toBeGreaterThan(0);
    const admitted = await readPluginControlUiAssets(project.rootDir, first);
    expect(chunks.every((name) => admitted.assets.has(name))).toBe(true);
    const built = await project.load(first.entry);
    expect(await built.loadDependencies("value")).toEqual([
      "literal dependency",
      "glob dependency",
    ]);
    const original = await project.read(first.entry);
    await project.write("lazy.js", 'export const value = "updated dependency";');
    const changedChunk = await project.build();
    expect(changedChunk.entry).not.toBe(first.entry);
    const changed = await project.load(changedChunk.entry);
    expect(await changed.loadDependencies("value")).toEqual([
      "updated dependency",
      "glob dependency",
    ]);
    // A fresh process must still resolve the previous generation's relative chunks.
    expect(
      JSON.parse(
        execNodeEvalSync(
          `import { loadDependencies } from ${JSON.stringify(pathToFileURL(path.join(project.rootDir, first.entry)).href)}; console.log(JSON.stringify(await loadDependencies("value")));`,
        ),
      ),
    ).toEqual(["literal dependency", "glob dependency"]);
    await project.write(project.source, 'export const message = "second";');
    await expect(project.build(true)).rejects.toThrow("missing or stale");
    const next = await project.build();
    expect(next.entry).not.toBe(first.entry);
    expect(await project.read(first.entry)).toBe(original);
    expect((await readJson(project.rootDir, "openclaw.plugin.json")).controlUi).toEqual(first);
  });

  it("rejects a split build that the asset reader cannot admit", async () => {
    const project = await fixture();
    await Promise.all(
      Array.from({ length: CONTROL_UI_PLUGIN_MAX_ASSETS }, (_, index) =>
        project.write(`part-${index}.js`, `export const value = ${index};`),
      ),
    );
    await project.write(
      project.source,
      `export const pages = [${Array.from({ length: CONTROL_UI_PLUGIN_MAX_ASSETS }, (_, index) => `() => import("./part-${index}.js")`).join(",")}];`,
    );
    await expect(project.build()).rejects.toThrow("at most 128 assets");
    await expectGenerations(project);
  });

  it("reuses a Windows build collision only when every asset matches", async () => {
    const project = await fixture();
    const first = await project.build();
    const collision = Object.assign(new Error("directory already exists"), { code: "EPERM" });
    vi.spyOn(fs, "rename").mockRejectedValue(collision);

    expect(await project.build()).toEqual(first);
    assert.ok(first.styles?.[0]);
    const stylesheet = project.file(first.styles[0]);
    const script = project.file(first.entry);
    const generation = path.dirname(script);
    const originalStyles = await fs.readFile(stylesheet, "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(generation, 0o700);
      await fs.chmod(stylesheet, 0o600);
      await fs.chmod(script, 0o600);
    }
    // CSS sorts before JavaScript; reject the later mismatch before normalizing either file.
    await fs.writeFile(script, "export const tampered = true;");
    await expect(project.build()).rejects.toThrow("immutable Control UI build was modified");
    expect(await fs.readFile(script, "utf8")).toBe("export const tampered = true;");
    expect(await fs.readFile(stylesheet, "utf8")).toBe(originalStyles);
    if (process.platform !== "win32") {
      expect(
        await Promise.all(
          [generation, stylesheet, script].map(
            async (target) => (await fs.stat(target)).mode & 0o777,
          ),
        ),
      ).toEqual([0o700, 0o600, 0o600]);
    }
    await expectGenerations(project, first.entry);
  });

  // Windows chmod only toggles the read-only attribute, so exact POSIX mode bits
  // are asserted where the Gateway can actually run as a different UID.
  it.skipIf(process.platform === "win32")(
    "normalizes fresh and validated browser generation permissions",
    async () => {
      const project = await fixture();
      // A restrictive umask on the build host leaves the parent owner-only as well.
      const generations = project.file("dist/control-ui");
      await fs.mkdir(generations, { recursive: true, mode: 0o700 });
      const first = await project.build();
      const generation = project.file(path.dirname(first.entry));
      const modeOf = async (target: string) => ((await fs.stat(target)).mode & 0o777).toString(8);
      assert.ok(first.styles?.[0]);
      const script = project.file(first.entry);
      const stylesheet = project.file(first.styles[0]);
      const paths = [generations, generation, script, stylesheet];
      const modes = () => Promise.all(paths.map(modeOf));
      expect(await modes()).toEqual(["755", "755", "644", "644"]);
      const assets = (await fs.readdir(generation)).map((name) => path.join(generation, name));
      const originalAssets = await Promise.all(assets.map((file) => fs.readFile(file)));
      expect(await Promise.all(assets.map(modeOf))).toEqual(assets.map(() => "644"));

      // A generation published by an earlier build stays reusable and is normalized in place.
      await fs.chmod(generations, 0o700);
      await fs.chmod(generation, 0o700);
      await Promise.all(assets.map((file) => fs.chmod(file, 0o600)));
      expect(await project.build(true)).toEqual(first);
      expect(await modes()).toEqual(["700", "700", "600", "600"]);
      expect(await project.build()).toEqual(first);
      expect(await modes()).toEqual(["755", "755", "644", "644"]);
      expect(await Promise.all(assets.map(modeOf))).toEqual(assets.map(() => "644"));
      expect(await Promise.all(assets.map((file) => fs.readFile(file)))).toEqual(originalAssets);
      expect(await modeOf(project.rootDir)).toBe("700");
      expect(await modeOf(path.dirname(generations))).toBe("700");
    },
  );

  it("bundles SDK source instead of stale dist under NODE_ENV=production", async () => {
    const project = await fixture();
    const sdkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-build-sdk-"));
    directories.push(sdkRoot);
    await Promise.all(
      ["src/plugin-sdk", "dist/plugin-sdk", "extensions"].map((dir) =>
        fs.mkdir(path.join(sdkRoot, dir), { recursive: true }),
      ),
    );
    await writeFiles(sdkRoot, {
      "package.json": JSON.stringify({
        name: "openclaw",
        type: "module",
        bin: { openclaw: "openclaw.mjs" },
        exports: { "./plugin-sdk/control-ui": { default: "./dist/plugin-sdk/control-ui.js" } },
      }),
      "src/plugin-sdk/control-ui.ts": 'export const origin = "source";',
      "dist/plugin-sdk/control-ui.js": 'export const origin = "stale dist";',
    });
    await project.write(project.source, 'export { origin } from "openclaw/plugin-sdk/control-ui";');
    const build = (nodeEnv: string | undefined) =>
      withEnvAsync({ NODE_ENV: nodeEnv, OPENCLAW_DEV_SOURCE_ROOT: sdkRoot }, () => project.build());

    const development = await build(undefined);
    const production = await build("production");

    expect(production).toEqual(development);
    const built = await project.load(production.entry);
    expect(built.origin).toBe("source");
  });

  it.each(
    unresolvedPluginImportCases.filter(
      ({ name }) =>
        name === "dynamic import" ||
        name === "indirect require" ||
        name === "local require.resolve",
    ),
  )("rejects unresolved $name without publishing a browser build", async (testCase) => {
    const { file, expected = "required dependency", diagnostic = "will not be bundled" } = testCase;
    const project = await fixture();
    const first = await publish(project);
    const manifest = await project.read("openclaw.plugin.json");
    const runOriginal = await createPluginImportFixture(project.file("runtime"), testCase);
    expect(runOriginal()).toBe(expected);
    await project.write(project.source, `export { loadDependency } from "./runtime/${file}";\n`);
    await expect(project.build()).rejects.toThrow(diagnostic);
    expect(await project.read("openclaw.plugin.json")).toBe(manifest);
    await expectGenerations(project, first.entry);
  });

  it("leaves the published build usable when browser compilation fails", async () => {
    const project = await fixture();
    const first = await publish(project);
    const manifest = await project.read("openclaw.plugin.json");
    await project.write(project.source, 'import fs from "node:fs"; export default fs;');
    await expect(project.build()).rejects.toThrow();
    expect(await project.read("openclaw.plugin.json")).toBe(manifest);
    const retained = await project.load(first.entry);
    expect(retained.message).toBe("first");
    expect(await retained.loadDependencies("value")).toEqual([
      "literal dependency",
      "glob dependency",
    ]);
  });

  it("rejects source entries outside the authoring package", async () => {
    const project = await fixture();
    const outside = await fixture();
    await expect(
      buildPluginControlUi({ ...project, source: path.join(outside.rootDir, "index.ts") }),
    ).rejects.toThrow("inside the plugin");
  });
});
