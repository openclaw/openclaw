import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayStartupMetadataPluginIds,
  resolveGatewayStartupPluginPlanFromRegistry,
} from "./channel-plugin-ids.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

describe("context engine startup ownership", () => {
  it("resolves declared context engine ownership through metadata scope and startup", () => {
    const { index, manifestRegistry } = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "lossless-claw",
          kind: "context-engine",
          origin: "installed" as PluginManifestRecord["origin"],
          enabledByDefault: false,
          contextEngineIds: ["Canonical-Engine"],
        },
      ],
    });
    const config: OpenClawConfig = {
      plugins: {
        allow: ["lossless-claw"],
        entries: { "lossless-claw": { enabled: true } },
        slots: { contextEngine: "Canonical-Engine" },
      },
    };
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: {},
        index,
        manifestRegistry,
      }).pluginIds,
    ).toContain("lossless-claw");
    const scope = resolveGatewayStartupMetadataPluginIds({
      config,
      env: {},
      index,
    });
    expect(scope).toContain("lossless-claw");
    expect(scope).not.toContain("Canonical-Engine");
  });
});
