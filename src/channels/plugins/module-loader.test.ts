// Module loader tests cover channel plugin module resolution and import failure handling.
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadChannelPluginModule, resolveExistingPluginModulePath } from "./module-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
});

describe("channel plugin module loader helpers", () => {
  it.each(["mtsx"])("resolves extensionless plugin module specifiers to %s", (extension) => {
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
    const expectedPath = path.join(rootDir, "src", `checker.${extension}`);
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, "export const ok = true;\n", "utf8");

    expect(resolveExistingPluginModulePath(rootDir, "./src/checker")).toBe(expectedPath);
  });

  it("still reports a module outside the plugin root as a boundary escape", () => {
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
    const outsideDir = tempDirs.make("openclaw-channel-module-loader-");
    const modulePath = path.join(outsideDir, "evil.cjs");
    fs.writeFileSync(modulePath, "module.exports = { ok: true };\n", "utf8");

    expect(() => loadChannelPluginModule({ modulePath, rootDir })).toThrow(
      `plugin module path escapes plugin root or fails alias checks: ${modulePath}`,
    );
  });

  it("uses native require for eligible JavaScript modules without creating Jiti", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ ok: false })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const loaderModule = await importFreshModule<typeof import("./module-loader.js")>(
      import.meta.url,
      "./module-loader.js?scope=native-require",
    );
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
    const modulePath = path.join(rootDir, "dist", "extensions", "demo", "index.cjs");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "module.exports = { ok: true };\n", "utf8");

    expect(
      loaderModule.loadChannelPluginModule({
        modulePath,
        rootDir,
      }),
    ).toEqual({ ok: true });
    expect(createJiti).not.toHaveBeenCalled();
  });

  it.each(["tsx"])(
    "loads typed %s channel modules with JavaScript sibling specifiers",
    (extension) => {
      const rootDir = tempDirs.make("openclaw-channel-module-loader-");
      const modulePath = path.join(rootDir, `index.${extension}`);
      fs.writeFileSync(path.join(rootDir, "value.ts"), 'export const value = "loaded";\n', "utf8");
      fs.writeFileSync(
        modulePath,
        'import { value } from "./value.js";\nexport const result: string = value;\n',
        "utf8",
      );

      expect(loadChannelPluginModule({ modulePath, rootDir })).toMatchObject({ result: "loaded" });
    },
  );
});
