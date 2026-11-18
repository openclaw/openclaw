import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupMetadataPluginIds } from "./gateway-startup-plugin-metadata.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

it.each(["selected-memory", "Selected-Memory"])(
  "retains the dreaming sidecar in startup and metadata scopes for %s",
  (selectedId) => {
    const manifestRegistry = {
      plugins: ["memory-core", selectedId].map((id) =>
        createPluginManifestRecordFixture({ id, kind: "memory" }),
      ),
      diagnostics: [],
    };
    const index = createInstalledPluginIndexFixture(manifestRegistry);
    const config: OpenClawConfig = {
      channels: {},
      plugins: {
        allow: [selectedId],
        slots: { memory: selectedId },
        entries: {
          [selectedId]: { enabled: true, config: { dreaming: { enabled: true } } },
        },
      },
    };
    const expected = ["memory-core", selectedId];
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({ config, env: {}, index, manifestRegistry })
        .pluginIds,
    ).toEqual(expected);
    expect(resolveGatewayStartupMetadataPluginIds({ config, env: {}, index })).toEqual(expected);
  },
);

it.each([true, false])(
  "starts an enabled non-owner memory plugin only when it opts in as a backend (%s)",
  (memoryBackend) => {
    const manifestRegistry = {
      plugins: ["memory-fusion", "memory-store"].map((id) =>
        createPluginManifestRecordFixture({ id, kind: "memory", origin: "global" }),
      ),
      diagnostics: [],
    };
    const index = createInstalledPluginIndexFixture(manifestRegistry);
    const config: OpenClawConfig = {
      channels: {},
      plugins: {
        slots: { memory: "memory-fusion" },
        entries: {
          "memory-fusion": { enabled: true },
          "memory-store": { enabled: true, memoryBackend },
        },
      },
    };
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({ config, env: {}, index, manifestRegistry })
        .pluginIds,
    ).toEqual(memoryBackend ? ["memory-fusion", "memory-store"] : ["memory-fusion"]);
  },
);
