import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalDependencyValues = ["literal dependency", "glob dependency"];
async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
}

async function expectNoBuild(rootDir: string) {
  await expect(fs.access(path.join(rootDir, "dist/control-ui"))).rejects.toThrow("ENOENT");
}
const modeOf = async (target: string) => (await fs.stat(target)).mode & 0o777;

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginCache();
  vi.unstubAllGlobals();
});

async function fixture(files: Record<string, string> = {}) {
  const directory = tempDirs.make("openclaw-ui-build-");
  const at = (name: string) => path.join(directory, name);
  await fs.mkdir(path.join(directory, "node_modules"));
  await fs.symlink(
    path.resolve("node_modules/esbuild"),
    path.join(directory, "node_modules/esbuild"),
    "dir",
  );
  await writeFiles(directory, {
    "package.json": JSON.stringify({ name: "ui-build-fixture", type: "module" }),
    "index.ts":
      'import "./style.css"; export const message = "first";\n' +
      'export async function loadDependencies(name: string) { return [(await import("./lazy.js")).value, (await import("./localized/" + name + ".js")).value]; }\n',
    "style.css": ".fixture { color: var(--text); }",
    "lazy.js": 'export const value = "literal dependency";',
    "localized/value.js": 'export const value = "glob dependency";',
    ...files,
  });
  const project = {
    rootDir: directory,
    source: "index.ts",
    at,
    write: (name: string, content: string) => fs.writeFile(at(name), content),
    read: (name: string) => fs.readFile(at(name), "utf8"),
    import: (entry: string) => import(pathToFileURL(at(entry)).href),
    build: (check = false) =>
      buildPluginControlUi({ rootDir: directory, source: "index.ts", check }),
    generations: () => fs.readdir(path.join(directory, "dist/control-ui")),
    paths(declaration: Awaited<ReturnType<typeof buildPluginControlUi>>) {
      assert.ok(declaration.styles?.[0]);
      const script = at(declaration.entry);
      return { script, generation: path.dirname(script), stylesheet: at(declaration.styles[0]) };
    },
  };
  return {
    ...project,
    async publish() {
      const first = await project.build();
      await writePluginBuildManifest(directory, { id: "fixture", controlUi: first });
      const manifest = await project.read("openclaw.plugin.json");
      return {
        first,
        async expectUnchanged() {
          expect(await project.read("openclaw.plugin.json")).toBe(manifest);
          expect(await project.generations()).toEqual([path.basename(path.dirname(first.entry))]);
        },
      };
    },
  };
}

describe("plugin build manifest publication", () => {
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
  it.each([true, false, "settings-only"])(
    "builds runtime browser artifacts without changing authored plugin metadata (authored UI: %s)",
    async (authoredUi) => {
      const project = await fixture();
      const packageJson = JSON.parse(await project.read("package.json"));
      packageJson.openclaw = { controlUi: project.source };
      await project.write("package.json", JSON.stringify(packageJson));
      const authored = {
        id: "fixture",
        configSchema: { type: "object", properties: { token: { type: "string" } } },
        activation: { onStartup: true },
        ...(authoredUi
          ? {
              controlUi: {
                entry: "dist/control-ui/authored/index.js",
                ...(authoredUi === "settings-only"
                  ? {
                      activation: "settings-only",
                      settingsViews: [
                        { section: "memory", panel: "overview" },
                        { section: "memory", panel: "memories" },
                      ],
                    }
                  : {}),
              },
            }
          : {}),
      };
      const original = JSON.stringify(authored, null, 2);
      await project.write("openclaw.plugin.json", original);
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
      expect(await project.read("openclaw.plugin.json")).toBe(original);
      const generated = JSON.parse(await project.read("dist/openclaw.plugin.json"));
      expect(generated.controlUi.activation).toBe(
        authoredUi === "settings-only" ? "settings-only" : undefined,
      );
      expect(generated.controlUi.settingsViews).toEqual(
        authoredUi === "settings-only"
          ? [
              { section: "memory", panel: "overview" },
              { section: "memory", panel: "memories" },
            ]
          : undefined,
      );
      expect(await project.build(true)).toEqual(generated.controlUi);
      generated.id = "previous-name";
      generated.configSchema = { type: "object", properties: {} };
      generated.activation = { onStartup: false };
      await project.write("dist/openclaw.plugin.json", JSON.stringify(generated));
      const loaded = loadPluginManifest(project.rootDir);
      expect(loaded).toMatchObject({
        ok: true,
        manifest: { ...authored, controlUi: generated.controlUi },
      });
      const assets = await readPluginControlUiAssets(project.rootDir, generated.controlUi);
      expect(assets.entryName).toBe("index.js");
      const built = await project.import(generated.controlUi.entry);
      expect(built.message).toBe("first");
    },
  );

  it("preserves esbuild's existing non-Solid JSX compilation", async () => {
    const project = await fixture({
      "renderer.js":
        "export const createElement = (tag, props, ...children) => ({ tag, props, children });",
      "view.tsx":
        'import * as React from "./renderer.js"; export const view = <p>Existing JSX</p>;',
      "index.ts": 'export * from "./view.tsx";',
    });
    const declaration = await project.build();
    const built = await project.import(declaration.entry);
    expect(built.view).toEqual({ tag: "p", props: null, children: ["Existing JSX"] });
  });

  it("bundles a Solid TSX view with reactive updates and owned disposal", async () => {
    const project = await fixture();
    const dependencies = project.at("node_modules");
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
      const built = await project.import(declaration.entry);
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
    expect(await project.generations()).toEqual([path.basename(path.dirname(first.entry))]);
  });

  it("removes unused dependency loaders without treating text as imports", async () => {
    const project = await fixture({
      "dependency.js":
        'export const message = "import(variable)"; export const unused = (specifier) => import(specifier);',
      "index.ts": '// import(anotherVariable)\nexport { message } from "./dependency.js";',
    });
    const result = await project.build();
    const built = await project.import(result.entry);
    expect(built.message).toBe("import(variable)");
  });

  it("rejects a retained computed import in a split output chunk", async () => {
    const project = await fixture({
      "page.js": "export const load = (specifier) => import(specifier);",
      "index.ts": 'export const loadPage = () => import("./page.js");',
    });
    await expect(project.build()).rejects.toThrow("will not be bundled");
    await expectNoBuild(project.rootDir);
  });

  it.each([
    { name: "static import", source: 'export { value } from "https://example.invalid/plugin.js";' },
    {
      name: "literal dynamic import",
      source: 'export const load = () => import("https://example.invalid/plugin.js");',
    },
  ])("rejects a retained external $name", async ({ source }) => {
    const project = await fixture({ "index.ts": source });
    await expect(project.build()).rejects.toThrow("must bundle their browser dependencies");
    await expectNoBuild(project.rootDir);
  });

  it("publishes complete immutable generations and detects stale source", async () => {
    const project = await fixture();
    const { first } = await project.publish();
    expect(first.entry).toMatch(/^dist\/control-ui\/[a-f0-9]{64}\/index.js$/u);
    expect(first.styles).toHaveLength(1);
    expect(await project.build()).toEqual(first);
    expect(await project.build(true)).toEqual(first);
    const generation = project.at(path.dirname(first.entry));
    const chunks = (await fs.readdir(generation)).filter((name) => name.startsWith("chunk-"));
    expect(chunks.length).toBeGreaterThan(0);
    const admitted = await readPluginControlUiAssets(project.rootDir, first);
    expect(chunks.every((name) => admitted.assets.has(name))).toBe(true);
    const built = await project.import(first.entry);
    expect(await built.loadDependencies("value")).toEqual(originalDependencyValues);
    const original = await project.read(first.entry);
    await project.write("lazy.js", 'export const value = "updated dependency";');
    const changedChunk = await project.build();
    expect(changedChunk.entry).not.toBe(first.entry);
    const changed = await project.import(changedChunk.entry);
    expect(await changed.loadDependencies("value")).toEqual([
      "updated dependency",
      "glob dependency",
    ]);
    // A fresh process must still resolve the previous generation's relative chunks.
    expect(
      JSON.parse(
        execNodeEvalSync(
          `import { loadDependencies } from ${JSON.stringify(pathToFileURL(project.at(first.entry)).href)}; console.log(JSON.stringify(await loadDependencies("value")));`,
        ),
      ),
    ).toEqual(originalDependencyValues);
    await project.write(project.source, 'export const message = "second";');
    await expect(project.build(true)).rejects.toThrow("missing or stale");
    const next = await project.build();
    expect(next.entry).not.toBe(first.entry);
    expect(await project.read(first.entry)).toBe(original);
    expect(JSON.parse(await project.read("openclaw.plugin.json")).controlUi).toEqual(first);
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
    await expectNoBuild(project.rootDir);
  });

  it("reuses a Windows build collision only when every asset matches", async () => {
    const project = await fixture();
    const first = await project.build();
    const collision = Object.assign(new Error("directory already exists"), { code: "EPERM" });
    vi.spyOn(fs, "rename").mockRejectedValue(collision);

    expect(await project.build()).toEqual(first);
    const { stylesheet, script, generation } = project.paths(first);
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
      expect(await Promise.all([generation, stylesheet, script].map(modeOf))).toEqual([
        0o700, 0o600, 0o600,
      ]);
    }
    expect(await project.generations()).toEqual([path.basename(path.dirname(first.entry))]);
  });

  // Windows chmod only toggles the read-only attribute, so exact POSIX mode bits
  // are asserted where the Gateway can actually run as a different UID.
  it.skipIf(process.platform === "win32")(
    "normalizes fresh and validated browser generation permissions",
    async () => {
      const project = await fixture();
      // A restrictive umask on the build host leaves the parent owner-only as well.
      const generations = project.at("dist/control-ui");
      await fs.mkdir(generations, { recursive: true, mode: 0o700 });
      const first = await project.build();
      const { generation, script, stylesheet } = project.paths(first);
      const modes = () => Promise.all([generations, generation, script, stylesheet].map(modeOf));
      expect(await modes()).toEqual([0o755, 0o755, 0o644, 0o644]);
      const assets = (await fs.readdir(generation)).map((name) => path.join(generation, name));
      const originalAssets = await Promise.all(assets.map((file) => fs.readFile(file)));
      expect(await Promise.all(assets.map(modeOf))).toEqual(assets.map(() => 0o644));

      // A generation published by an earlier build stays reusable and is normalized in place.
      await fs.chmod(generations, 0o700);
      await fs.chmod(generation, 0o700);
      await Promise.all(assets.map((file) => fs.chmod(file, 0o600)));
      expect(await project.build(true)).toEqual(first);
      expect(await modes()).toEqual([0o700, 0o700, 0o600, 0o600]);
      expect(await project.build()).toEqual(first);
      expect(await modes()).toEqual([0o755, 0o755, 0o644, 0o644]);
      expect(await Promise.all(assets.map(modeOf))).toEqual(assets.map(() => 0o644));
      expect(await Promise.all(assets.map((file) => fs.readFile(file)))).toEqual(originalAssets);
      expect(await Promise.all([project.rootDir, path.dirname(generations)].map(modeOf))).toEqual([
        0o700, 0o700,
      ]);
    },
  );

  it("bundles SDK source instead of stale dist under NODE_ENV=production", async () => {
    const project = await fixture();
    const sdkRoot = tempDirs.make("openclaw-ui-build-sdk-");
    await fs.mkdir(path.join(sdkRoot, "extensions"));
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
    const built = await project.import(production.entry);
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
    const { expectUnchanged } = await project.publish();
    const runOriginal = await createPluginImportFixture(project.at("runtime"), testCase);
    expect(runOriginal()).toBe(expected);
    await project.write(project.source, `export { loadDependency } from "./runtime/${file}";\n`);
    await expect(project.build()).rejects.toThrow(diagnostic);
    await expectUnchanged();
  });

  it("leaves the published build usable when browser compilation fails", async () => {
    const project = await fixture();
    const { first, expectUnchanged } = await project.publish();
    await project.write(project.source, 'import fs from "node:fs"; export default fs;');
    await expect(project.build()).rejects.toThrow();
    await expectUnchanged();
    const retained = await project.import(first.entry);
    expect(retained.message).toBe("first");
    expect(await retained.loadDependencies("value")).toEqual(originalDependencyValues);
  });

  it("rejects source entries outside the authoring package", async () => {
    const project = await fixture();
    const outside = await fixture();
    await expect(
      buildPluginControlUi({ ...project, source: path.join(outside.rootDir, "index.ts") }),
    ).rejects.toThrow("inside the plugin");
  });
});
