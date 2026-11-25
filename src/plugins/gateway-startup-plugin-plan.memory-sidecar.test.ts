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

const store = (expected: string[]) => ["memory-fusion", ...expected];
it.each([
  { owner: false, entry: { memoryBackend: true }, expected: store(["memory-store"]) },
  { owner: false, entry: { memoryBackend: false }, expected: store([]) },
  { owner: false, entry: {}, expected: store([]) },
  { owner: true, entry: {}, expected: store(["memory-store"]) },
  { owner: true, entry: { memoryBackend: false }, expected: store([]) },
])(
  "starts a non-owner memory plugin as a backend only when requested (owner $owner, $entry)",
  ({ owner, entry, expected }) => {
    const manifestRegistry = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "memory-fusion",
          kind: "memory",
          origin: "global",
          ...(owner ? { memoryBackends: true } : {}),
        }),
        createPluginManifestRecordFixture({ id: "memory-store", kind: "memory", origin: "global" }),
      ],
      diagnostics: [],
    };
    const index = createInstalledPluginIndexFixture(manifestRegistry);
    const config: OpenClawConfig = {
      channels: {},
      plugins: {
        slots: { memory: "memory-fusion" },
        entries: {
          "memory-fusion": { enabled: true },
          "memory-store": { enabled: true, ...entry },
        },
      },
    };
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({ config, env: {}, index, manifestRegistry })
        .pluginIds,
    ).toEqual(expected);
  },
);
