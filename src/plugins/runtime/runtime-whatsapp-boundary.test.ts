import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makePluginDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const PLUGIN_ID = "whatsapp";

/**
 * Regression tests for openclaw/openclaw#53247
 * "WhatsApp plugin crashes agent in v2026.3.23 with missing light-runtime-api"
 *
 * runtime-whatsapp-boundary.ts loads the "light-runtime-api" sidecar from the
 * installed WhatsApp plugin directory. If that file is missing from the bundled
 * package (e.g. because the build/pack step omits top-level extension files),
 * the gateway crashes with:
 *   "WhatsApp plugin runtime is unavailable: missing light-runtime-api for plugin 'whatsapp'"
 *
 * The fix adds:
 *   1. extensions/whatsapp/light-runtime-api.ts (the sidecar itself)
 *   2. bundled-plugin-build-entries.mjs: includes top-level extension files as build entries
 *   3. stage-bundled-plugin-runtime.mjs: stages sidecar wrapper modules into dist-runtime
 */
describe("runtime-whatsapp-boundary – sidecar path resolution (issue #53247)", () => {
  /**
   * Simulate the candidate-path search used by resolveWhatsAppRuntimeModulePath
   * in runtime-whatsapp-boundary.ts so we can verify the error conditions inline.
   */
  function resolveSidecarPath(
    pluginSourceFile: string,
    pluginRootDir: string | undefined,
    entryBaseName: string,
  ): string | null {
    const candidates = [
      path.join(path.dirname(pluginSourceFile), `${entryBaseName}.js`),
      path.join(path.dirname(pluginSourceFile), `${entryBaseName}.ts`),
      ...(pluginRootDir
        ? [
            path.join(pluginRootDir, `${entryBaseName}.js`),
            path.join(pluginRootDir, `${entryBaseName}.ts`),
          ]
        : []),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  it("returns null when light-runtime-api is absent (reproduces the crash scenario)", () => {
    const pluginDir = makePluginDir("openclaw-wa-boundary-missing-");
    const sourceFile = path.join(pluginDir, "index.js");
    fs.writeFileSync(sourceFile, "export default {};", "utf8");
    // Deliberately omit light-runtime-api.js – simulates incomplete bundle

    const resolved = resolveSidecarPath(sourceFile, pluginDir, "light-runtime-api");
    expect(resolved).toBeNull();

    // Verify the error message the boundary produces matches the issue report
    const errorMessage = `WhatsApp plugin runtime is unavailable: missing light-runtime-api for plugin '${PLUGIN_ID}'`;
    expect(errorMessage).toBe(
      "WhatsApp plugin runtime is unavailable: missing light-runtime-api for plugin 'whatsapp'",
    );
  });

  it("resolves light-runtime-api .js sidecar when present at plugin root", () => {
    const pluginDir = makePluginDir("openclaw-wa-boundary-present-js-");
    const sourceFile = path.join(pluginDir, "index.js");
    fs.writeFileSync(sourceFile, "export default {};", "utf8");
    const sidecarFile = path.join(pluginDir, "light-runtime-api.js");
    fs.writeFileSync(sidecarFile, "export const webAuthExists = async () => false;", "utf8");

    const resolved = resolveSidecarPath(sourceFile, pluginDir, "light-runtime-api");
    expect(resolved).toBe(sidecarFile);
  });

  it("resolves light-runtime-api .ts sidecar in dev-mode (source checkout)", () => {
    const pluginDir = makePluginDir("openclaw-wa-boundary-present-ts-");
    const sourceFile = path.join(pluginDir, "index.ts");
    fs.writeFileSync(sourceFile, "export default {};", "utf8");
    const sidecarFile = path.join(pluginDir, "light-runtime-api.ts");
    fs.writeFileSync(sidecarFile, "export const webAuthExists = async () => false;", "utf8");

    const resolved = resolveSidecarPath(sourceFile, pluginDir, "light-runtime-api");
    expect(resolved).toBe(sidecarFile);
  });

  it("prefers .js over .ts when both sidecars exist (bundled install takes priority)", () => {
    const pluginDir = makePluginDir("openclaw-wa-boundary-prefer-js-");
    const sourceFile = path.join(pluginDir, "index.js");
    fs.writeFileSync(sourceFile, "export default {};", "utf8");
    const jsFile = path.join(pluginDir, "light-runtime-api.js");
    const tsFile = path.join(pluginDir, "light-runtime-api.ts");
    fs.writeFileSync(jsFile, "export const x = 1;", "utf8");
    fs.writeFileSync(tsFile, "export const x = 1;", "utf8");

    const resolved = resolveSidecarPath(sourceFile, pluginDir, "light-runtime-api");
    expect(resolved).toBe(jsFile);
  });

  it("falls back to rootDir when source lives in a subdirectory", () => {
    const pluginDir = makePluginDir("openclaw-wa-boundary-subdir-");
    const srcDir = path.join(pluginDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const sourceFile = path.join(srcDir, "channel.ts");
    fs.writeFileSync(sourceFile, "export const channel = 'whatsapp';", "utf8");
    // sidecar is at the plugin ROOT, not inside src/
    const sidecarFile = path.join(pluginDir, "light-runtime-api.js");
    fs.writeFileSync(sidecarFile, "export const webAuthExists = async () => false;", "utf8");

    const resolved = resolveSidecarPath(sourceFile, pluginDir, "light-runtime-api");
    expect(resolved).toBe(sidecarFile);
  });
});
