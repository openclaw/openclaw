import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadClawdbotPlugins } from "./loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `clawdbot-plugin-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePlugin(params: { id: string; body: string }): TempPlugin {
  const dir = makeTempDir();
  const file = path.join(dir, `${params.id}.js`);
  fs.writeFileSync(file, params.body, "utf-8");
  return { dir, file, id: params.id };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("loadClawdbotPlugins", () => {
  it("loads plugins from config paths", () => {
    const plugin = writePlugin({
      id: "allowed",
      body: `export default function (api) { api.registerGatewayMethod("allowed.ping", ({ respond }) => respond(true, { ok: true })); }`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["allowed"],
        },
      },
    });

    expect(registry.plugins.length).toBe(1);
    expect(registry.plugins[0]?.status).toBe("loaded");
    expect(Object.keys(registry.gatewayHandlers)).toContain("allowed.ping");
  });

  it("denylist disables plugins even if allowed", () => {
    const plugin = writePlugin({
      id: "blocked",
      body: `export default function () {}`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["blocked"],
          deny: ["blocked"],
        },
      },
    });

    expect(registry.plugins[0]?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    const plugin = writePlugin({
      id: "configurable",
      body: `export default {\n  id: "configurable",\n  configSchema: {\n    parse(value) {\n      if (!value || typeof value !== "object" || Array.isArray(value)) {\n        throw new Error("bad config");\n      }\n      return value;\n    }\n  },\n  register() {}\n};`,
    });

    const registry = loadClawdbotPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            configurable: {
              config: "nope" as unknown as Record<string, unknown>,
            },
          },
        },
      },
    });

    expect(registry.plugins[0]?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });
});
