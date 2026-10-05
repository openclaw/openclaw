import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

  it.each([
    { mode: 0o644, parentMode: 0o755 },
    { mode: 0o640, parentMode: 0o3770 },
  ])(
    "preserves mode $mode and parent mode $parentMode across rewrites",
    async ({ mode, parentMode }) => {
      const rootDir = tempDirs.make("openclaw-build-manifest-");
      const manifestPath = path.join(rootDir, "openclaw.plugin.json");
      const initial = { id: "fixture", value: "first" };
      await fs.writeFile(manifestPath, `${JSON.stringify(initial, null, 2)}\n`);
      if (process.platform !== "win32") {
        await fs.chmod(manifestPath, mode);
        await fs.chmod(rootDir, parentMode);
      }

      for (const manifest of [initial, { ...initial, value: "second" }]) {
        await writePluginBuildManifest(rootDir, manifest);
        expect(await fs.readFile(manifestPath, "utf8")).toBe(
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        if (process.platform !== "win32") {
          expect((await fs.stat(manifestPath)).mode & 0o7777).toBe(mode);
          expect((await fs.stat(rootDir)).mode & 0o7777).toBe(parentMode);
        }
        expect(await fs.readdir(rootDir)).toEqual(["openclaw.plugin.json"]);
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    { mask: 0o002, expectedMode: 0o664 },
    { mask: 0o077, expectedMode: 0o600 },
  ])("creates a manifest under isolated umask $mask", async ({ mask, expectedMode }) => {
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
  });

  it.each(["missing", "file"] as const)(
    "rejects a %s plugin root without creating it",
    async (kind) => {
      const directory = tempDirs.make("openclaw-build-manifest-");
      const rootDir = path.join(directory, "plugin");
      if (kind === "file") {
        await fs.writeFile(rootDir, "not a directory");
      }
      await expect(writePluginBuildManifest(rootDir, { id: "fixture" })).rejects.toMatchObject({
        // Windows distinguishes file traversal from recursive mkdir on an existing file.
        code:
          kind === "file" && process.platform === "win32"
            ? expect.stringMatching(/^(ENOENT|EEXIST)$/)
            : kind === "missing"
              ? "ENOENT"
              : "ENOTDIR",
      });
      expect(await fs.readdir(directory)).toEqual(kind === "missing" ? [] : ["plugin"]);
      if (kind === "file") {
        expect(await fs.readFile(rootDir, "utf8")).toBe("not a directory");
      }
    },
  );

  it("publishes through a symlink plugin root without replacing the link", async () => {
    const directory = tempDirs.make("openclaw-build-manifest-");
    const rootDir = path.join(directory, "plugin");
    const linkedRoot = path.join(directory, "linked-plugin");
    await fs.mkdir(rootDir);
    await fs.symlink(rootDir, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const linkBefore = await fs.readlink(linkedRoot);
    await writePluginBuildManifest(linkedRoot, { id: "fixture" });
    expect(await fs.readFile(path.join(rootDir, "openclaw.plugin.json"), "utf8")).toBe(
      '{\n  "id": "fixture"\n}\n',
    );
    expect((await fs.lstat(linkedRoot)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linkedRoot)).toBe(linkBefore);
  });

  it.each(["write", "rename", "cleanup"] as const)(
    "preserves the prior manifest and reports a %s failure before publication",
    async (failure) => {
      const rootDir = tempDirs.make("openclaw-build-manifest-");
      const manifestPath = path.join(rootDir, "openclaw.plugin.json");
      const original = '{\n  "id": "previous"\n}\n';
      await fs.writeFile(manifestPath, original);
      const publicationError = new Error("manifest publication failed");
      const cleanupError = new Error("manifest cleanup failed");
      const isStagedPath = (file: unknown) =>
        typeof file === "string" && path.dirname(file) === rootDir && file.endsWith(".tmp");
      let stagedHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let publicationFailed = false;
      let cleanupFailed = false;
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await realOpen(file, flags, mode);
        if (isStagedPath(file)) {
          stagedHandle = handle;
        }
        return handle;
      });
      const realWrite = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        if (failure === "write" && (isStagedPath(file) || file === stagedHandle)) {
          await realWrite(file, "partial");
          publicationFailed = true;
          throw publicationError;
        }
        return realWrite(file, data, options);
      });
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (failure !== "write" && to === manifestPath) {
          publicationFailed = true;
          throw publicationError;
        }
        return realRename(from, to);
      });
      const realRm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (failure === "cleanup" && isStagedPath(file)) {
          cleanupFailed = true;
          throw cleanupError;
        }
        return realRm(file, options);
      });
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (failure === "cleanup" && isStagedPath(file)) {
          cleanupFailed = true;
          throw cleanupError;
        }
        return realUnlink(file);
      });

      await expect(writePluginBuildManifest(rootDir, { id: "next" })).rejects.toThrow(
        failure === "cleanup" ? "manifest cleanup failed" : "manifest publication failed",
      );
      expect(publicationFailed).toBe(true);
      expect(cleanupFailed).toBe(failure === "cleanup");
      expect(await fs.readFile(manifestPath, "utf8")).toBe(original);
      const residual = (await fs.readdir(rootDir)).filter(
        (name) => name !== "openclaw.plugin.json",
      );
      expect(residual).toHaveLength(failure === "cleanup" ? 1 : 0);
      if (failure === "cleanup") {
        const temporary = residual[0];
        assert.ok(temporary);
        expect(await fs.readFile(path.join(rootDir, temporary), "utf8")).toBe(
          '{\n  "id": "next"\n}\n',
        );
      }

      vi.restoreAllMocks();
      await writePluginBuildManifest(rootDir, { id: "retry" });
      expect(await fs.readFile(manifestPath, "utf8")).toBe('{\n  "id": "retry"\n}\n');
      expect((await fs.readdir(rootDir)).toSorted()).toEqual(
        ["openclaw.plugin.json", ...residual].toSorted(),
      );
    },
  );
});

describe("native plugin browser builds", () => {
  it("publishes complete immutable generations and detects stale source", async () => {
    const project = await fixture();
    const first = await buildPluginControlUi(project);
    await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
    expect(first.entry).toMatch(/^dist\/control-ui\/[a-f0-9]{64}\/index.js$/u);
    expect(first.styles).toHaveLength(1);
    expect(await buildPluginControlUi(project)).toEqual(first);
    expect(await buildPluginControlUi({ ...project, check: true })).toEqual(first);
    const built = await import(pathToFileURL(path.join(project.rootDir, first.entry)).href);
    expect(await built.loadDependencies("value")).toEqual([
      "literal dependency",
      "glob dependency",
    ]);
    const original = await fs.readFile(path.join(project.rootDir, first.entry), "utf8");
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

  it("retries a transient Windows rename denial when the destination is absent", async () => {
    const project = await fixture();
    const realRename = fs.rename.bind(fs);
    let renameCalls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        throw Object.assign(new Error("transient rename denial"), { code: "EPERM" });
      }
      return realRename(from, to);
    });

    const published = await buildPluginControlUi(project);
    expect(published.entry).toMatch(/^dist\/control-ui\/[a-f0-9]{64}\/index.js$/u);
    // The first denied rename was retried rather than misread as a prior generation.
    expect(renameCalls).toBeGreaterThan(1);
    expect(await fs.readdir(path.join(project.rootDir, "dist/control-ui"))).toEqual([
      path.basename(path.dirname(published.entry)),
    ]);
  });

  it("fails cleanly when a rename denial never clears and no destination appears", async () => {
    const project = await fixture();
    const denial = Object.assign(new Error("persistent rename denial"), { code: "EPERM" });
    vi.spyOn(fs, "rename").mockRejectedValue(denial);

    await expect(buildPluginControlUi(project)).rejects.toThrow("could not be published");
    // No half-published generation and no leftover staging directory.
    expect(await fs.readdir(path.join(project.rootDir, "dist/control-ui"))).toEqual([]);
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
      const originalAssets = await Promise.all(
        [script, stylesheet].map((file) => fs.readFile(file)),
      );

      // A generation published by an earlier build stays reusable and is normalized in place.
      await fs.chmod(generations, 0o700);
      await fs.chmod(generation, 0o700);
      await fs.chmod(script, 0o600);
      await fs.chmod(stylesheet, 0o600);
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
      expect(await Promise.all([script, stylesheet].map((file) => fs.readFile(file)))).toEqual(
        originalAssets,
      );
      expect(await modeOf(project.rootDir)).toBe("700");
      expect(await modeOf(path.dirname(generations))).toBe("700");
    },
  );

  it("bundles browser-safe primitive SDK exports", async () => {
    const project = await fixture();
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'export { asDateTimestampMs, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";',
    );
    const artifact = await buildPluginControlUi(project);
    const built = await import(pathToFileURL(path.join(project.rootDir, artifact.entry)).href);
    expect(built.asDateTimestampMs(0)).toBe(0);
    expect(built.asDateTimestampMs("0")).toBeUndefined();
    expect(built.asDateTimestampMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(built.truncateUtf16Safe("A😀B", 2)).toBe("A");
  });

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

  it.each(unresolvedPluginImportCases)(
    "rejects unresolved $name without publishing a browser build",
    async (testCase) => {
      const {
        file,
        expected = "required dependency",
        diagnostic = "will not be bundled",
      } = testCase;
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
    },
  );

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
