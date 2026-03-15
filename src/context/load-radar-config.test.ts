import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRadarConfig, parseRadarDefenderCliArgs } from "./load-radar-config.js";

const tempDirs: string[] = [];

async function writeConfigFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radar-defender-config-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, content);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadRadarConfig", () => {
  it("merges defaults with a valid partial config", async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        server: { name: "custom-radar-defender" },
        review: { minimumSeverity: "high", outputMode: "markdown" },
        contextOverrides: { environment: "staging" },
      }),
    );

    const config = await loadRadarConfig(configPath);

    expect(config.server.name).toBe("custom-radar-defender");
    expect(config.server.transport).toBe("stdio");
    expect(config.review.minimumSeverity).toBe("high");
    expect(config.review.outputMode).toBe("markdown");
    expect(config.contextOverrides).toMatchObject({ environment: "staging" });
    expect(config.review.enabledTools.length).toBe(7);
  });

  it("rejects invalid top-level fields", async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        server: { name: "ok" },
        unexpected: true,
      }),
    );

    await expect(loadRadarConfig(configPath)).rejects.toThrow(/unexpected/i);
  });

  it("keeps contextOverrides extensible", async () => {
    const configPath = await writeConfigFile(
      JSON.stringify({
        contextOverrides: {
          productName: "Radar Meseriași",
          nested: { env: "prod", featureFlags: ["mcp"] },
        },
      }),
    );

    const config = await loadRadarConfig(configPath);

    expect(config.contextOverrides).toEqual({
      productName: "Radar Meseriași",
      nested: { env: "prod", featureFlags: ["mcp"] },
    });
  });
});

describe("parseRadarDefenderCliArgs", () => {
  it("parses config and transport flags", () => {
    expect(
      parseRadarDefenderCliArgs([
        "node",
        "src/mcp/run.ts",
        "--config",
        "./config/radar.json",
        "--transport",
        "stdio",
      ]),
    ).toEqual({
      configPath: "./config/radar.json",
      transport: "stdio",
    });
  });

  it("rejects unsupported transport", () => {
    expect(() =>
      parseRadarDefenderCliArgs(["node", "src/mcp/run.ts", "--transport", "http"]),
    ).toThrow(/Unsupported transport/i);
  });
});
