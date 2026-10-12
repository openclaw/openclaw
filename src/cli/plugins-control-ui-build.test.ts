import assert from "node:assert/strict";
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
import { withEnvAsync } from "../test-utils/env.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import {
  createPluginImportFixture,
  unresolvedPluginImportCases,
} from "./plugins-build-bundle.test-support.js";
import { buildPluginControlUi, writePluginBuildManifest } from "./plugins-control-ui-build.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-build-"));
  directories.push(directory);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "ui-build-fixture", type: "module" }),
  );
  await fs.symlink(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
  await fs.writeFile(
    path.join(directory, "index.ts"),
    'import "./style.css"; export const message = "first";',
  );
  await fs.writeFile(path.join(directory, "style.css"), ".fixture { color: var(--text); }");
  await fs.writeFile(path.join(directory, "lazy.js"), 'export const value = "literal dependency";');
  await fs.mkdir(path.join(directory, "localized"));
  await fs.writeFile(
    path.join(directory, "localized/value.js"),
    'export const value = "glob dependency";',
  );
  await fs.appendFile(
    path.join(directory, "index.ts"),
    '\nexport async function loadDependencies(name: string) { return [(await import("./lazy.js")).value, (await import("./localized/" + name + ".js")).value]; }\n',
  );
  return { rootDir: directory, source: "index.ts" };
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
  it("preserves esbuild's existing non-Solid JSX compilation", async () => {
    const project = await fixture();
    await fs.writeFile(
      path.join(project.rootDir, "renderer.js"),
      "export const createElement = (tag, props, ...children) => ({ tag, props, children });",
    );
    await fs.writeFile(
      path.join(project.rootDir, "view.tsx"),
      'import * as React from "./renderer.js"; export const view = <p>Existing JSX</p>;',
    );
    await fs.writeFile(path.join(project.rootDir, project.source), 'export * from "./view.tsx";');
    const declaration = await buildPluginControlUi(project);
    const built = await import(pathToFileURL(path.join(project.rootDir, declaration.entry)).href);
    expect(built.view).toEqual({ tag: "p", props: null, children: ["Existing JSX"] });
  });

  it("bundles a Solid TSX view with reactive updates and owned disposal", async () => {
    const project = await fixture();
    const dependencies = path.join(project.rootDir, "node_modules");
    await fs.unlink(dependencies);
    await fs.mkdir(path.join(dependencies, "@solidjs"), { recursive: true });
    for (const name of ["esbuild", "solid-js", "@solidjs/web", "@solidjs/compiler"]) {
      const owner = name === "esbuild" ? "node_modules" : "ui/node_modules";
      await fs.symlink(path.resolve(owner, name), path.join(dependencies, name), "dir");
    }
    await fs.writeFile(
      path.join(project.rootDir, "view.tsx"),
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
    await fs.writeFile(path.join(project.rootDir, project.source), 'export * from "./view.tsx";');
    const declaration = await buildPluginControlUi(project);
    const dom = new JSDOM("<body><main></main></body>");
    vi.stubGlobal("document", dom.window.document);
    try {
      const built = await import(pathToFileURL(path.join(project.rootDir, declaration.entry)).href);
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
    const first = await buildPluginControlUi(project);
    await fs.writeFile(
      path.join(project.rootDir, "view.tsx"),
      "/** @jsxImportSource @solidjs/web */\nexport const view = <p>Ready</p>;",
    );
    await fs.writeFile(path.join(project.rootDir, project.source), 'export * from "./view.tsx";');
    await expect(buildPluginControlUi(project)).rejects.toThrow(
      "Install @solidjs/compiler in this plugin's devDependencies",
    );
    expect(await fs.readdir(path.join(project.rootDir, "dist/control-ui"))).toEqual([
      path.basename(path.dirname(first.entry)),
    ]);
  });

  it("removes unused dependency loaders without treating text as imports", async () => {
    const project = await fixture();
    await fs.writeFile(
      path.join(project.rootDir, "dependency.js"),
      'export const message = "import(variable)"; export const unused = (specifier) => import(specifier);',
    );
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      '// import(anotherVariable)\nexport { message } from "./dependency.js";',
    );
    const result = await buildPluginControlUi(project);
    const built = await import(pathToFileURL(path.join(project.rootDir, result.entry)).href);
    expect(built.message).toBe("import(variable)");
  });

  it("rejects a retained computed import in a split output chunk", async () => {
    const project = await fixture();
    await fs.writeFile(
      path.join(project.rootDir, "page.js"),
      "export const load = (specifier) => import(specifier);",
    );
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'export const loadPage = () => import("./page.js");',
    );
    await expect(buildPluginControlUi(project)).rejects.toThrow("will not be bundled");
    await expect(fs.access(path.join(project.rootDir, "dist/control-ui"))).rejects.toThrow(
      "ENOENT",
    );
  });

  it.each([
    { name: "static import", source: 'export { value } from "https://example.invalid/plugin.js";' },
    {
      name: "literal dynamic import",
      source: 'export const load = () => import("https://example.invalid/plugin.js");',
    },
  ])("rejects a retained external $name", async ({ source }) => {
    const project = await fixture();
    await fs.writeFile(path.join(project.rootDir, project.source), source);
    await expect(buildPluginControlUi(project)).rejects.toThrow(
      "must bundle their browser dependencies",
    );
    await expect(fs.access(path.join(project.rootDir, "dist/control-ui"))).rejects.toThrow(
      "ENOENT",
    );
  });

  it("publishes complete immutable generations and detects stale source", async () => {
    const project = await fixture();
    const first = await buildPluginControlUi(project);
    await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
    expect(first.entry).toMatch(/^dist\/control-ui\/[a-f0-9]{64}\/index.js$/u);
    expect(first.styles).toHaveLength(1);
    expect(await buildPluginControlUi(project)).toEqual(first);
    expect(await buildPluginControlUi({ ...project, check: true })).toEqual(first);
    const generation = path.join(project.rootDir, path.dirname(first.entry));
    const chunks = (await fs.readdir(generation)).filter((name) => name.startsWith("chunk-"));
    expect(chunks.length).toBeGreaterThan(0);
    const admitted = await readPluginControlUiAssets(project.rootDir, first);
    expect(chunks.every((name) => admitted.assets.has(name))).toBe(true);
    const built = await import(pathToFileURL(path.join(project.rootDir, first.entry)).href);
    expect(await built.loadDependencies("value")).toEqual([
      "literal dependency",
      "glob dependency",
    ]);
    const original = await fs.readFile(path.join(project.rootDir, first.entry), "utf8");
    await fs.writeFile(
      path.join(project.rootDir, "lazy.js"),
      'export const value = "updated dependency";',
    );
    const changedChunk = await buildPluginControlUi(project);
    expect(changedChunk.entry).not.toBe(first.entry);
    const changed = await import(
      pathToFileURL(path.join(project.rootDir, changedChunk.entry)).href
    );
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
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'export const message = "second";',
    );
    await expect(buildPluginControlUi({ ...project, check: true })).rejects.toThrow(
      "missing or stale",
    );
    const next = await buildPluginControlUi(project);
    expect(next.entry).not.toBe(first.entry);
    expect(await fs.readFile(path.join(project.rootDir, first.entry), "utf8")).toBe(original);
    expect(
      JSON.parse(await fs.readFile(path.join(project.rootDir, "openclaw.plugin.json"), "utf8"))
        .controlUi,
    ).toEqual(first);
  });

  it("rejects a split build that the asset reader cannot admit", async () => {
    const project = await fixture();
    await Promise.all(
      Array.from({ length: CONTROL_UI_PLUGIN_MAX_ASSETS }, (_, index) =>
        fs.writeFile(
          path.join(project.rootDir, `part-${index}.js`),
          `export const value = ${index};`,
        ),
      ),
    );
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      `export const pages = [${Array.from({ length: CONTROL_UI_PLUGIN_MAX_ASSETS }, (_, index) => `() => import("./part-${index}.js")`).join(",")}];`,
    );
    await expect(buildPluginControlUi(project)).rejects.toThrow("at most 128 assets");
    await expect(fs.access(path.join(project.rootDir, "dist/control-ui"))).rejects.toThrow(
      "ENOENT",
    );
  });

  it("reuses a Windows build collision only when every asset matches", async () => {
    const project = await fixture();
    const first = await buildPluginControlUi(project);
    const collision = Object.assign(new Error("directory already exists"), { code: "EPERM" });
    vi.spyOn(fs, "rename").mockRejectedValue(collision);

    expect(await buildPluginControlUi(project)).toEqual(first);
    assert.ok(first.styles?.[0]);
    const stylesheet = path.join(project.rootDir, first.styles[0]);
    const script = path.join(project.rootDir, first.entry);
    const generation = path.dirname(script);
    const originalStyles = await fs.readFile(stylesheet, "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(generation, 0o700);
      await fs.chmod(stylesheet, 0o600);
      await fs.chmod(script, 0o600);
    }
    // CSS sorts before JavaScript; reject the later mismatch before normalizing either file.
    await fs.writeFile(script, "export const tampered = true;");
    await expect(buildPluginControlUi(project)).rejects.toThrow(
      "immutable Control UI build was modified",
    );
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
    expect(await fs.readdir(path.join(project.rootDir, "dist/control-ui"))).toEqual([
      path.basename(path.dirname(first.entry)),
    ]);
  });

  // Windows chmod only toggles the read-only attribute, so exact POSIX mode bits
  // are asserted where the Gateway can actually run as a different UID.
  it.skipIf(process.platform === "win32")(
    "normalizes fresh and validated browser generation permissions",
    async () => {
      const project = await fixture();
      // A restrictive umask on the build host leaves the parent owner-only as well.
      const generations = path.join(project.rootDir, "dist/control-ui");
      await fs.mkdir(generations, { recursive: true, mode: 0o700 });
      const first = await buildPluginControlUi(project);
      const generation = path.join(project.rootDir, path.dirname(first.entry));
      const modeOf = async (target: string) => ((await fs.stat(target)).mode & 0o777).toString(8);
      expect(await modeOf(generations)).toBe("755");
      expect(await modeOf(generation)).toBe("755");
      assert.ok(first.styles?.[0]);
      const script = path.join(project.rootDir, first.entry);
      const stylesheet = path.join(project.rootDir, first.styles[0]);
      expect(await modeOf(script)).toBe("644");
      expect(await modeOf(stylesheet)).toBe("644");
      const assets = (await fs.readdir(generation)).map((name) => path.join(generation, name));
      const originalAssets = await Promise.all(assets.map((file) => fs.readFile(file)));
      expect(await Promise.all(assets.map(modeOf))).toEqual(assets.map(() => "644"));

      // A generation published by an earlier build stays reusable and is normalized in place.
      await fs.chmod(generations, 0o700);
      await fs.chmod(generation, 0o700);
      await Promise.all(assets.map((file) => fs.chmod(file, 0o600)));
      expect(await buildPluginControlUi({ ...project, check: true })).toEqual(first);
      expect(await Promise.all([generations, generation, script, stylesheet].map(modeOf))).toEqual([
        "700",
        "700",
        "600",
        "600",
      ]);
      expect(await buildPluginControlUi(project)).toEqual(first);
      expect(await modeOf(generations)).toBe("755");
      expect(await modeOf(generation)).toBe("755");
      expect(await modeOf(script)).toBe("644");
      expect(await modeOf(stylesheet)).toBe("644");
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
    await fs.writeFile(
      path.join(sdkRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        bin: { openclaw: "openclaw.mjs" },
        exports: { "./plugin-sdk/control-ui": { default: "./dist/plugin-sdk/control-ui.js" } },
      }),
    );
    await fs.writeFile(
      path.join(sdkRoot, "src/plugin-sdk/control-ui.ts"),
      'export const origin = "source";',
    );
    await fs.writeFile(
      path.join(sdkRoot, "dist/plugin-sdk/control-ui.js"),
      'export const origin = "stale dist";',
    );
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'export { origin } from "openclaw/plugin-sdk/control-ui";',
    );
    const build = (nodeEnv: string | undefined) =>
      withEnvAsync({ NODE_ENV: nodeEnv, OPENCLAW_DEV_SOURCE_ROOT: sdkRoot }, () =>
        buildPluginControlUi(project),
      );

    const development = await build(undefined);
    const production = await build("production");

    expect(production).toEqual(development);
    const built = await import(pathToFileURL(path.join(project.rootDir, production.entry)).href);
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
    const first = await buildPluginControlUi(project);
    await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
    const manifestPath = path.join(project.rootDir, "openclaw.plugin.json");
    const manifest = await fs.readFile(manifestPath, "utf8");
    const runOriginal = await createPluginImportFixture(
      path.join(project.rootDir, "runtime"),
      testCase,
    );
    expect(runOriginal()).toBe(expected);
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      `export { loadDependency } from "./runtime/${file}";\n`,
    );
    await expect(buildPluginControlUi(project)).rejects.toThrow(diagnostic);
    expect(await fs.readFile(manifestPath, "utf8")).toBe(manifest);
    expect(await fs.readdir(path.join(project.rootDir, "dist/control-ui"))).toEqual([
      path.basename(path.dirname(first.entry)),
    ]);
  });

  it("leaves the published build usable when browser compilation fails", async () => {
    const project = await fixture();
    const first = await buildPluginControlUi(project);
    await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
    const manifest = await fs.readFile(path.join(project.rootDir, "openclaw.plugin.json"), "utf8");
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'import fs from "node:fs"; export default fs;',
    );
    await expect(buildPluginControlUi(project)).rejects.toThrow();
    expect(await fs.readFile(path.join(project.rootDir, "openclaw.plugin.json"), "utf8")).toBe(
      manifest,
    );
    expect(await fs.readFile(path.join(project.rootDir, first.entry), "utf8")).toContain("first");
  });

  it("rejects source entries outside the authoring package", async () => {
    const project = await fixture();
    const outside = await fixture();
    await expect(
      buildPluginControlUi({ ...project, source: path.join(outside.rootDir, "index.ts") }),
    ).rejects.toThrow("inside the plugin");
  });
});
