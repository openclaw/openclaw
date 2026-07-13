import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigLayers, parseConfigLayerArguments } from "./config-layers.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-config-layers-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseConfigLayerArguments", () => {
  it("preserves declared order", () => {
    const parsed = parseConfigLayerArguments(["global=global.json", "operator=operator.json"]);
    expect(parsed.map((entry) => entry.id)).toEqual(["global", "operator"]);
  });

  it("rejects malformed and duplicate declarations", () => {
    expect(() => parseConfigLayerArguments(["global"])).toThrow("invalid --config-layer value");
    expect(() => parseConfigLayerArguments(["global=one.json", "global=two.json"])).toThrow(
      "duplicate --config-layer id",
    );
  });
});

describe("loadConfigLayers", () => {
  it("resolves includes and returns a validated gateway startup snapshot", async () => {
    const directory = await temporaryDirectory();
    const included = path.join(directory, "included.json");
    const global = path.join(directory, "global.json");
    const operator = path.join(directory, "operator.json");
    await writeFile(included, JSON.stringify({ gateway: { mode: "local" } }));
    await writeFile(
      global,
      JSON.stringify({ $include: "./included.json", tools: { deny: ["exec"] } }),
    );
    await writeFile(operator, JSON.stringify({ tools: { deny: ["exec", "web"] } }));

    const loaded = await loadConfigLayers(["global=" + global, "operator=" + operator]);

    expect(loaded?.snapshot.sourceConfig).toMatchObject({
      gateway: { mode: "local" },
      tools: { deny: ["exec", "web"] },
    });
    expect(loaded?.snapshot.valid).toBe(true);
    expect(loaded?.pluginMetadataSnapshot).toBeDefined();
  });

  it("surfaces authority conflicts", async () => {
    const directory = await temporaryDirectory();
    const global = path.join(directory, "global.json");
    const operator = path.join(directory, "operator.json");
    await writeFile(global, JSON.stringify({ gateway: { mode: "local" } }));
    await writeFile(operator, JSON.stringify({ gateway: { mode: "remote" } }));

    await expect(loadConfigLayers(["global=" + global, "operator=" + operator])).rejects.toThrow(
      "ControlledByEarlierLayer",
    );
  });

  it("rejects bootstrap-owned keys introduced by an include", async () => {
    const directory = await temporaryDirectory();
    const included = path.join(directory, "included.json");
    const layer = path.join(directory, "layer.json");
    await writeFile(included, JSON.stringify({ env: { TEST_SECRET: "value" } }));
    await writeFile(layer, JSON.stringify({ $include: "./included.json" }));

    await expect(loadConfigLayers(["global=" + layer])).rejects.toThrow(
      "bootstrap-owned root keys",
    );
  });

  it("rejects an invalid composed OpenClaw config", async () => {
    const directory = await temporaryDirectory();
    const layer = path.join(directory, "layer.json");
    await writeFile(layer, JSON.stringify({ gateway: { port: "not-a-port" } }));

    await expect(loadConfigLayers(["global=" + layer])).rejects.toThrow(
      "invalid composed configuration",
    );
  });
});
