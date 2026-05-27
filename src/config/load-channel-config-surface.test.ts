import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChannelConfigSurfaceModule } from "../../scripts/load-channel-config-surface.ts";

const tempDirs: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function importLoaderWithMissingBun() {
  vi.resetModules();
  const spawnSync = vi.fn(() => ({
    error: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
    status: null,
    stdout: "",
    stderr: "",
  }));
  vi.doMock("node:child_process", () => ({ spawnSync }));

  try {
    const imported = await import("../../scripts/load-channel-config-surface.ts");
    return { loadChannelConfigSurfaceModule: imported.loadChannelConfigSurfaceModule, spawnSync };
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadChannelConfigSurfaceModule", () => {
  it("falls back to Jiti when bun is unavailable", async () => {
    const repoRoot = makeTempRoot("openclaw-config-surface-");
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

  it("retries from an isolated package copy when extension-local node_modules is broken", async () => {
    const repoRoot = makeTempRoot("openclaw-config-surface-");
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

    await expect(loadChannelConfigSurfaceModule(modulePath, { repoRoot })).resolves.toMatchObject({
      schema: {
        type: "object",
        properties: {
          ok: { type: "string" },
        },
      },
    });
  });
});
