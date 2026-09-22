import path from "node:path";
import { expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { listSessionFixture } from "./session-list.test-support.js";

test.each([
  { search: undefined, recordedModel: false },
  { search: undefined, recordedModel: true },
  { search: "unmatched-runtime-search", recordedModel: false },
  { search: "unmatched-runtime-search", recordedModel: true },
  { search: "list-model", recordedModel: false },
])(
  "reuses prepared metadata across session rows (search=$search, recordedModel=$recordedModel)",
  async ({ search, recordedModel }) => {
    await withStateDirEnv("openclaw-prepared-row-auth-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      const pluginRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(pluginRegistry);
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "example/list-alias", thinkingDefault: "off" },
        },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "list-model-owner",
            modelIdNormalization: {
              providers: { example: { aliases: { "list-alias": "list-model" } } },
            },
          },
        ],
      });
      const modelCatalog = new Map([
        [
          "main",
          createPreparedGatewayModelCatalog({
            entries: [{ provider: "example", id: "list-model", name: "Synthetic model" }],
            pluginRegistry,
            metadataSnapshot,
          }),
        ],
      ]);
      const metadata = await import("../plugins/current-plugin-metadata-snapshot.js");
      const lookup = vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot");
      const project = async (count: number) => {
        const store: Record<string, SessionEntry> = Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `agent:main:dashboard:prepared-${index}`,
            {
              sessionId: `prepared-${index}`,
              updatedAt: index + 1,
              displayName: `Session ${index}`,
              ...(recordedModel ? { modelProvider: "example", model: "list-model" } : {}),
            },
          ]),
        );
        lookup.mockClear();
        const result = await listSessionFixture({
          cfg,
          store,
          storePath: path.join(stateDir, "sessions.json"),
          modelCatalog,
          opts: { limit: count, ...(search ? { search } : {}) },
        });
        expect(result.count).toBe(search === "unmatched-runtime-search" ? 0 : count);
        expect(result.defaults.model).toBe("list-model");
        expect(result.sessions.every((session) => session.model === "list-model")).toBe(true);
        return lookup.mock.calls.length;
      };
      try {
        await project(1);
        const small = await project(16);
        const large = await project(128);
        expect(large).toBeLessThanOrEqual(small + 4);
      } finally {
        lookup.mockRestore();
      }
    });
  },
);
