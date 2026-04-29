import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectGatewayCpuObservations,
  collectMetricObservations,
  discoverBundledPluginManifests,
  schemaHasRequiredFields,
  selectPluginEntries,
} from "../../scripts/lib/plugin-gateway-gauntlet.mjs";

describe("plugin gateway gauntlet helpers", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-gauntlet-"));
    await fs.mkdir(path.join(repoRoot, "extensions"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function writeManifest(pluginDir: string, fileName: string, source: string) {
    const dir = path.join(repoRoot, "extensions", pluginDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), source, "utf8");
  }

  it("discovers bundled plugin manifests into lifecycle matrix rows", async () => {
    await writeManifest(
      "alpha",
      "openclaw.plugin.json",
      JSON.stringify({
        id: "alpha",
        enabledByDefault: true,
        providers: ["openai"],
        commandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
        auth: [{ method: "oauth", onboardingScopes: ["models"] }],
        configSchema: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              required: ["token"],
            },
          },
        },
      }),
    );
    await writeManifest(
      "beta",
      "openclaw.plugin.json5",
      `{ id: "beta", commandAliases: ["dreaming"], onboardingScopes: ["memory"] }`,
    );

    const matrix = discoverBundledPluginManifests(repoRoot);

    expect(matrix.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(matrix[0]).toMatchObject({
      id: "alpha",
      dir: path.join("extensions", "alpha"),
      manifestPath: path.join("extensions", "alpha", "openclaw.plugin.json"),
      enabledByDefault: true,
      providers: ["openai"],
      authMethods: ["oauth"],
      onboardingScopes: ["models"],
      hasConfigSchema: true,
      hasRequiredConfigFields: true,
      cliCommandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
    });
    expect(matrix[1].runtimeSlashAliases).toEqual([
      { name: "dreaming", kind: "runtime-slash", cliCommand: null },
    ]);
  });

  it("selects plugin shards after explicit id filtering", () => {
    const entries = ["a", "b", "c", "d"].map((id) => ({ id }));

    expect(selectPluginEntries(entries, { ids: ["d", "b"], shardTotal: 2, shardIndex: 0 })).toEqual(
      [{ id: "b" }],
    );
    expect(() => selectPluginEntries(entries, { ids: ["missing"] })).toThrow(
      "Unknown bundled plugin id(s): missing",
    );
  });

  it("detects required schema fields recursively", () => {
    expect(
      schemaHasRequiredFields({
        type: "object",
        properties: {
          auth: {
            oneOf: [{ type: "object" }, { type: "object", required: ["token"] }],
          },
        },
      }),
    ).toBe(true);
    expect(
      schemaHasRequiredFields({ type: "object", properties: { enabled: { type: "boolean" } } }),
    ).toBe(false);
  });

  it("flags gateway startup CPU observations using bench summary keys", () => {
    expect(
      collectGatewayCpuObservations({
        startup: {
          results: [
            {
              id: "default",
              summary: {
                cpuCoreRatio: { max: 1.1 },
                readyzMs: { max: 45_000 },
              },
            },
          ],
        },
        qa: {
          metrics: {
            gatewayCpuCoreRatio: 1.2,
            wallMs: 60_000,
          },
        },
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 30_000,
      }),
    ).toEqual([
      {
        kind: "startup-cpu-hot",
        id: "default",
        cpuCoreRatioMax: 1.1,
        wallMsMax: 45_000,
      },
      {
        kind: "qa-cpu-hot",
        id: "qa-suite",
        cpuCoreRatio: 1.2,
        wallMs: 60_000,
      },
    ]);
  });

  it("flags absolute peaks and phase-relative anomalies", () => {
    const observations = collectMetricObservations(
      [
        { pluginId: "a", phase: "lifecycle:install", wallMs: 100, maxRssMb: 100 },
        { pluginId: "b", phase: "lifecycle:install", wallMs: 110, maxRssMb: 110 },
        {
          pluginId: "c",
          phase: "lifecycle:install",
          wallMs: 1_000,
          cpuCoreRatio: 1.2,
          maxRssMb: 500,
        },
      ],
      {
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 900,
        maxRssWarnMb: 450,
        wallAnomalyMultiplier: 3,
        rssAnomalyMultiplier: 2.5,
      },
    );

    expect(observations.map((observation) => observation.kind)).toEqual([
      "phase-cpu-hot",
      "phase-wall-anomaly",
      "phase-rss-high",
      "phase-rss-anomaly",
    ]);
  });
});
