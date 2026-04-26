import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  copyBundledHookMetadata,
  copyStaticExtensionAssets,
  listStaticExtensionAssetOutputs,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("runtime postbuild static assets", () => {
  it("tracks plugin-owned static assets that release packaging must ship", () => {
    expect(listStaticExtensionAssetOutputs()).toContain(
      "dist/extensions/diffs/assets/viewer-runtime.js",
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
});

describe("copyBundledHookMetadata", () => {
  it("copies HOOK.md files from src/hooks/bundled/<hook>/ into dist/bundled/<hook>/", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-hooks-");
    const srcHookDir = path.join(rootDir, "src", "hooks", "bundled", "session-memory");
    await fs.mkdir(srcHookDir, { recursive: true });
    await fs.writeFile(
      path.join(srcHookDir, "HOOK.md"),
      "---\nname: session-memory\n---\n",
      "utf8",
    );
    // dist/bundled/session-memory/handler.js already exists from a tsdown build;
    // simulate that so we cover the "alongside-handler" case rather than a clean dest.
    const distHookDir = path.join(rootDir, "dist", "bundled", "session-memory");
    await fs.mkdir(distHookDir, { recursive: true });
    await fs.writeFile(path.join(distHookDir, "handler.js"), "export default () => {};\n", "utf8");

    copyBundledHookMetadata({ rootDir });

    expect(await fs.readFile(path.join(distHookDir, "HOOK.md"), "utf8")).toBe(
      "---\nname: session-memory\n---\n",
    );
    // handler.js untouched
    expect(await fs.readFile(path.join(distHookDir, "handler.js"), "utf8")).toBe(
      "export default () => {};\n",
    );
  });

  it("warns and skips when a bundled hook directory has no HOOK.md", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-hooks-missing-");
    const srcHookDir = path.join(rootDir, "src", "hooks", "bundled", "incomplete");
    await fs.mkdir(srcHookDir, { recursive: true });
    const warn = vi.fn();

    copyBundledHookMetadata({ rootDir, warn });

    expect(warn).toHaveBeenCalledWith(
      "[runtime-postbuild] HOOK.md not found, skipping: incomplete",
    );
    await expect(
      fs.stat(path.join(rootDir, "dist", "bundled", "incomplete", "HOOK.md")),
    ).rejects.toThrow();
  });

  it("returns silently when src/hooks/bundled does not exist", () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-hooks-empty-");
    expect(() => copyBundledHookMetadata({ rootDir })).not.toThrow();
  });
});
