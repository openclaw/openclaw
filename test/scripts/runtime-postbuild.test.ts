import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  copyStaticExtensionAssets,
  listStaticExtensionAssetOutputs,
  rewriteRootRuntimeImportsToStableAliases,
  writeLegacyCliExitCompatChunks,
  writeLegacyRootRuntimeCompatAliases,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("runtime postbuild static assets", () => {
  it("tracks plugin-owned static assets that release packaging must ship", () => {
    expect(listStaticExtensionAssetOutputs()).toEqual(
      expect.arrayContaining([
        "dist/extensions/acpx/error-format.mjs",
        "dist/extensions/acpx/mcp-command-line.mjs",
        "dist/extensions/acpx/mcp-proxy.mjs",
        "dist/extensions/diffs/assets/viewer-runtime.js",
      ]),
    );
  });

  it("copies declared static assets into dist", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const src = "extensions/acpx/src/runtime-internals/mcp-proxy.mjs";
    const dest = "dist/extensions/acpx/mcp-proxy.mjs";
    const sourcePath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "proxy-data\n", "utf8");

    copyStaticExtensionAssets({
      rootDir,
      assets: [{ src, dest }],
    });

    expect(await fs.readFile(destPath, "utf8")).toBe("proxy-data\n");
  });

  it("warns when a declared static asset is missing", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const warn = vi.fn();

    copyStaticExtensionAssets({
      rootDir,
      assets: [{ src: "missing/file.mjs", dest: "dist/file.mjs" }],
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "[runtime-postbuild] static asset not found, skipping: missing/file.mjs",
    );
  });

  it("writes stable aliases for hashed root runtime modules", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-model-auth.runtime-XyZ987.js"),
      "export const auth = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-tts.runtime-AbCd1234.js"),
      "export const tts = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "library-Other123.js"),
      "export const x = true;\n",
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "runtime-model-auth.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-model-auth.runtime-XyZ987.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "runtime-tts.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-tts.runtime-AbCd1234.js";\n',
    );
    await expect(fs.stat(path.join(distDir, "library.js"))).rejects.toThrow();
  });

  it("does not write ambiguous stable aliases for colliding root runtime chunks", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "install.runtime-Aaa111.js"),
      "export const pluginInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-Bbb222.js"),
      "export const daemonInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime.js"),
      'export * from "./install.runtime-Stale.js";\n',
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    await expect(fs.stat(path.join(distDir, "install.runtime.js"))).rejects.toThrow();
  });

  it("keeps stable aliases when one colliding root runtime chunk re-exports the implementation", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-model-auth.runtime-Impl123.js"),
      "export const auth = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-model-auth.runtime-Wrap456.js"),
      'import { auth } from "./runtime-model-auth.runtime-Impl123.js";\nexport { auth };\n',
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "runtime-model-auth.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-model-auth.runtime-Wrap456.js";\n',
    );
  });

  it("rewrites root runtime imports to stable aliases", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-AbCd1234.js"),
      "export const ready = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "dispatch-OldHash.js"),
      [
        'const lazy = () => import("./runtime-plugins.runtime-AbCd1234.js");',
        'import "./missing.runtime-Nope.js";',
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "dispatch-OldHash.js"), "utf8")).toBe(
      [
        'const lazy = () => import("./runtime-plugins.runtime.js");',
        'import "./missing.runtime-Nope.js";',
        "",
      ].join("\n"),
    );
  });

  it("keeps hashed imports when a stable runtime alias would collide", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "install.runtime-Aaa111.js"),
      "export const pluginInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-Bbb222.js"),
      "export const daemonInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install-OldHash.js"),
      [
        'const pluginRuntime = () => import("./install.runtime-Aaa111.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "install-OldHash.js"), "utf8")).toBe(
      [
        'const pluginRuntime = () => import("./install.runtime-Aaa111.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
        "",
      ].join("\n"),
    );
  });

  it("leaves stable alias files pointing at their hashed runtime chunks", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-AbCd1234.js"),
      "export const ready = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime.js"),
      'export * from "./runtime-plugins.runtime-AbCd1234.js";\n',
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "runtime-plugins.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-plugins.runtime-AbCd1234.js";\n',
    );
  });

  it("writes compatibility aliases for previous release runtime chunk names", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime.js"),
      'export * from "./runtime-plugins.runtime-NewHash.js";\n',
      "utf8",
    );

    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(
      await fs.readFile(path.join(distDir, "runtime-plugins.runtime-fLHuT7Vs.js"), "utf8"),
    ).toBe('export * from "./runtime-plugins.runtime.js";\n');
    expect(
      await fs.readFile(path.join(distDir, "runtime-plugins.runtime-CNAfmQRG.js"), "utf8"),
    ).toBe('export * from "./runtime-plugins.runtime.js";\n');
  });

  it("writes legacy CLI exit compatibility chunks", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");

    writeLegacyCliExitCompatChunks({ rootDir });

    for (const chunk of ["memory-state-CcqRgDZU.js", "memory-state-DwGdReW4.js"]) {
      await expect(fs.readFile(path.join(rootDir, "dist", chunk), "utf8")).resolves.toContain(
        "function hasMemoryRuntime()",
      );
    }
  });
});
