import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadChannelConfigSurfaceModule } from "../../scripts/load-channel-config-surface.ts";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";

async function importLoaderWithMissingBun() {
  const spawnSync = vi.fn(() => ({
    error: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
    status: null,
    stdout: "",
    stderr: "",
  }));
  vi.doMock("node:child_process", () => ({ spawnSync }));

  try {
    const imported = await importFreshModule<
      typeof import("../../scripts/load-channel-config-surface.ts")
    >(import.meta.url, "../../scripts/load-channel-config-surface.ts?scope=missing-bun");
    return { loadChannelConfigSurfaceModule: imported.loadChannelConfigSurfaceModule, spawnSync };
  } finally {
    vi.doUnmock("node:child_process");
  }
}

describe("loadChannelConfigSurfaceModule", () => {
  it("falls back to Jiti when bun is unavailable", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const packageRoot = path.join(repoRoot, "extensions", "demo");
      const modulePath = path.join(packageRoot, "src", "config-schema.js");

      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openclaw/demo", type: "module" }, null, 2),
        "utf8",
      );
      fs.writeFileSync(
        modulePath,
        [
          "export const DemoChannelConfigSchema = {",
          "  schema: {",
          "    type: 'object',",
          "    properties: { ok: { type: 'string' } },",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const { loadChannelConfigSurfaceModule: loadWithMissingBun, spawnSync } =
        await importLoaderWithMissingBun();

      await expect(loadWithMissingBun(modulePath, { repoRoot })).resolves.toMatchObject({
        schema: {
          type: "object",
          properties: {
            ok: { type: "string" },
          },
        },
      });
      expect(spawnSync).toHaveBeenCalledWith("bun", expect.any(Array), expect.any(Object));
    });
  });

  it("retries from an isolated package copy when extension-local node_modules is broken", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const packageRoot = path.join(repoRoot, "extensions", "demo");
      const modulePath = path.join(packageRoot, "src", "config-schema.js");

      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openclaw/demo", type: "module" }, null, 2),
        "utf8",
      );
      fs.writeFileSync(
        modulePath,
        [
          "import { z } from 'zod';",
          "export const DemoChannelConfigSchema = {",
          "  schema: {",
          "    type: 'object',",
          "    properties: { ok: { type: z.object({}).shape ? 'string' : 'string' } },",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      fs.mkdirSync(path.join(repoRoot, "node_modules", "zod"), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, "node_modules", "zod", "package.json"),
        JSON.stringify({
          name: "zod",
          type: "module",
          exports: { ".": "./index.js" },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(repoRoot, "node_modules", "zod", "index.js"),
        "export const z = { object: () => ({ shape: {} }) };\n",
        "utf8",
      );

      const poisonedStorePackage = path.join(
        repoRoot,
        "node_modules",
        ".pnpm",
        "zod@0.0.0",
        "node_modules",
        "zod",
      );
      fs.mkdirSync(poisonedStorePackage, { recursive: true });
      fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
      fs.symlinkSync(
        "../../../node_modules/.pnpm/zod@0.0.0/node_modules/zod",
        path.join(packageRoot, "node_modules", "zod"),
        "dir",
      );

      await expect(loadChannelConfigSurfaceModule(modulePath, { repoRoot })).resolves.toMatchObject(
        {
          schema: {
            type: "object",
            properties: {
              ok: { type: "string" },
            },
          },
        },
      );
    });
  });
});
