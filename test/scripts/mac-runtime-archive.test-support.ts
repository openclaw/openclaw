import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { runMacFixtureTool } from "./mac-native-fixtures.test-support.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

export function registerMacRuntimeArchiveTests() {
  describe.runIf(process.platform === "darwin")("Mac runtime resource archive", () => {
    const test = createMacScriptTest();

    test("archives a runtime tree with docs and pnpm links while retaining native code", async ({
      mac,
    }) => {
      const root = mac.createTempDir("openclaw-runtime-archive-");
      const app = path.join(root, "OpenClaw.app");
      const resources = path.join(app, "Contents/Resources");
      const runtime = path.join(resources, "runtime");
      const packageRoot = path.join(runtime, "lib/node_modules/openclaw");
      const metadata = "lib/node_modules/openclaw/dist/build-info.json";
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await mkdir(path.join(runtime, "bin"));
      await mkdir(path.join(runtime, "empty"));
      await writeFile(path.join(runtime, metadata), '{"buildId":"fixture"}');
      await writeFile(path.join(runtime, "README.md"), "Runtime documentation\n");
      const script = "console.log('fixture');\n";
      await writeFile(path.join(packageRoot, "hello.js"), script, { mode: 0o755 });
      await symlink("lib/node_modules/openclaw/hello.js", path.join(runtime, "link"));
      await mkdir(path.join(runtime, "sidecar/.pnpm/pkg/node_modules/pkg"), { recursive: true });
      await writeFile(path.join(runtime, "sidecar/.pnpm/pkg/node_modules/pkg/index.js"), script);
      await symlink(".pnpm/pkg/node_modules/pkg", path.join(runtime, "sidecar/pkg"));
      const native = await readFile("/usr/bin/true");
      await writeFile(path.join(runtime, "bin/bun"), native, { mode: 0o755 });
      await writeFile(path.join(runtime, "bin/bun.md"), "Bun documentation\n");
      await writeFile(path.join(runtime, "sidecar/addon.node"), native, { mode: 0o755 });
      await writeFile(path.join(runtime, "sidecar/library.dylib"), native, { mode: 0o755 });
      await symlink("addon.node", path.join(runtime, "sidecar/native-link"));
      await utimes(path.join(runtime, "README.md"), 0, 0);
      await utimes(path.join(runtime, "empty"), 0, 0);
      const plist = path.join(app, "Contents/Info.plist");
      await writeFile(
        plist,
        '<?xml version="1.0"?><plist version="1.0"><dict><key>OpenClawRuntimeBuildID</key><string>fixture</string></dict></plist>',
      );

      await runMacFixtureTool(
        "/usr/bin/python3",
        [path.resolve("scripts/archive-mac-runtime.py"), app],
        root,
        mac,
      );
      const archive = path.join(resources, "runtime.aar");
      expect(await readFile(path.join(runtime, "bin/bun"))).toEqual(native);
      expect(existsSync(path.join(packageRoot, "hello.js"))).toBe(false);
      expect(existsSync(path.join(runtime, metadata))).toBe(false);
      expect(await readFile(path.join(runtime, "sidecar/addon.node"))).toEqual(native);
      expect(await readFile(path.join(runtime, "sidecar/library.dylib"))).toEqual(native);
      const info = JSON.parse(
        await runMacFixtureTool(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", plist],
          root,
          mac,
        ),
      );
      expect(info.OpenClawRuntimeArchiveSHA256).toBe(
        createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
      );
      expect(info.OpenClawRuntimeArchiveFormatVersion).toBe(1);
      expect(info.OpenClawRuntimeBuildID).toBe("fixture");

      const extracted = path.join(root, "extracted");
      await mkdir(extracted);
      await runMacFixtureTool(
        "/usr/bin/aa",
        ["extract", "-i", archive, "-d", extracted],
        root,
        mac,
      );
      const restoredScript = path.join(extracted, "lib/node_modules/openclaw/hello.js");
      expect(await readFile(restoredScript, "utf8")).toBe(script);
      expect((await stat(restoredScript)).mode & 0o777).toBe(0o755);
      expect(await readlink(path.join(extracted, "link"))).toBe(
        "lib/node_modules/openclaw/hello.js",
      );
      expect((await stat(path.join(extracted, "empty"))).isDirectory()).toBe(true);
      expect(existsSync(path.join(extracted, "bin/bun"))).toBe(false);
      expect(await readFile(path.join(extracted, "bin/bun.md"), "utf8")).toBe(
        "Bun documentation\n",
      );
      expect(existsSync(path.join(extracted, "sidecar/addon.node"))).toBe(false);
      expect(existsSync(path.join(extracted, "sidecar/library.dylib"))).toBe(false);
      expect(await readFile(path.join(extracted, metadata), "utf8")).toBe('{"buildId":"fixture"}');
      expect(await readFile(path.join(extracted, "README.md"), "utf8")).toBe(
        "Runtime documentation\n",
      );
      expect(await readlink(path.join(extracted, "sidecar/pkg"))).toBe(
        ".pnpm/pkg/node_modules/pkg",
      );
      expect(await readFile(path.join(extracted, "sidecar/pkg/index.js"), "utf8")).toBe(script);
      expect(await readlink(path.join(extracted, "sidecar/native-link"))).toBe("addon.node");
    });
  });
}
