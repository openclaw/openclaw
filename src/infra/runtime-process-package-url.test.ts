import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolvePackageRuntimeProcessEntrypointUrl } from "./runtime-process-package-url.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";

afterEach(() => vi.unstubAllGlobals());

it("runs a selected package's built entry before its source fallback", async () => {
  await withTempDir("openclaw-mcp-entry-", async (root) => {
    const source = path.join(root, "src/mcp/plugin-tools-serve.ts");
    const built = path.join(root, "dist/mcp/plugin-tools-serve.js");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(built), { recursive: true });
    await fs.writeFile(source, 'const kind: string = "source"; console.log(kind);');
    await fs.writeFile(built, 'console.log("built");');
    for (const expected of ["built", "source"]) {
      const url = resolvePackageRuntimeProcessEntrypointUrl("pluginToolsServe", root);
      const result = await promisify(execFile)(process.execPath, resolveRuntimeWorkerArgv(url), {
        cwd: root,
        timeout: 10_000,
      });
      expect(result.stdout.trim()).toBe(expected);
      if (expected === "built") {
        await fs.unlink(built);
      }
    }
  });
});

it("rejects a selected package with no declared entry output or source", async () => {
  await withTempDir("openclaw-mcp-missing-entry-", async (root) => {
    expect(() => resolvePackageRuntimeProcessEntrypointUrl("openclawToolsServe", root)).toThrow(
      `Runtime process entry openclawToolsServe is missing under ${root}`,
    );
  });
});

it("keeps an embedded entry launchable after its disk source is pruned", async () => {
  await withTempDir("openclaw-mcp-embedded-entry-", async (root) => {
    const built = path.join(root, "dist/mcp/openclaw-tools-serve.js");
    vi.stubGlobal("__openclawStandaloneIsEmbeddedModule", (filename: string) => filename === built);
    const selected = resolvePackageRuntimeProcessEntrypointUrl("openclawToolsServe", root);
    expect(selected).toEqual(pathToFileURL(built));
    await expect(fs.stat(fileURLToPath(selected))).rejects.toMatchObject({ code: "ENOENT" });
    const differentRoot = path.join(root, "different-package");
    expect(() =>
      resolvePackageRuntimeProcessEntrypointUrl("openclawToolsServe", differentRoot),
    ).toThrow("is missing");
  });
});
