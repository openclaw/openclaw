import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const jitiMockState = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("jiti", () => ({
  createJiti: (_url: string, options: Record<string, unknown>) => {
    jitiMockState.options = options;
    return () => ({
      default: {
        id: "mock-plugin",
        register() {},
      },
    });
  },
}));

import { loadOpenClawPlugins } from "./loader.js";

const fixtureRoot = path.join(os.tmpdir(), `openclaw-plugin-${randomUUID()}`);

function createPluginFixture(pluginId: string): { dir: string; entry: string } {
  const dir = path.join(fixtureRoot, pluginId);
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, "index.js");
  fs.writeFileSync(entry, "module.exports = {};", "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dir, entry };
}

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("loadOpenClawPlugins jiti native modules", () => {
  it("forces sqlite native packages through node require", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const pluginId = "native-modules-probe";
    const fixture = createPluginFixture(pluginId);

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: fixture.dir,
      config: {
        plugins: {
          load: { paths: [fixture.entry] },
          allow: [pluginId],
        },
      },
    });

    const nativeModules = jitiMockState.options?.nativeModules;
    expect(Array.isArray(nativeModules)).toBe(true);
    expect(nativeModules).toEqual(
      expect.arrayContaining(["typescript", "sqlite3", "better-sqlite3", "bindings"]),
    );
  });
});
