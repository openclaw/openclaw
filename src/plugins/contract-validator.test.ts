import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePluginContracts } from "./contract-validator.js";

const tempDirs: string[] = [];

function makePlugin(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-contract-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.js"), "export default {};\n", "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ source: "index.js", ...manifest }),
    "utf-8",
  );
  return dir;
}

function pluginCandidate(pluginDir: string) {
  return {
    idHint: path.basename(pluginDir),
    source: path.join(pluginDir, "index.js"),
    rootDir: pluginDir,
    origin: "config" as const,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("validatePluginContracts", () => {
  it("fails strict validation when tool metadata lacks contracts.tools", () => {
    const pluginDir = makePlugin({
      id: "bad-tools",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      toolMetadata: {
        demo_tool: { optional: true },
      },
    });

    const report = validatePluginContracts({
      config: { plugins: { load: { paths: [pluginDir] }, allow: ["bad-tools"] } },
      strict: true,
      env: { HOME: os.tmpdir(), OPENCLAW_NO_BUNDLED_PLUGINS: "1" },
      candidates: [pluginCandidate(pluginDir)],
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-tool-contract",
          pluginId: "bad-tools",
        }),
      ]),
    );
  });

  it("accepts matching tool metadata and contracts.tools", () => {
    const pluginDir = makePlugin({
      id: "good-tools",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: ["demo_tool"] },
      toolMetadata: {
        demo_tool: { optional: true },
      },
    });

    const report = validatePluginContracts({
      config: { plugins: { load: { paths: [pluginDir] }, allow: ["good-tools"] } },
      strict: true,
      env: { HOME: os.tmpdir(), OPENCLAW_NO_BUNDLED_PLUGINS: "1" },
      candidates: [pluginCandidate(pluginDir)],
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
