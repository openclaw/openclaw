import { afterAll, afterEach, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const surface = (contracts: string[]) => ({
  channels: [],
  providers: [],
  tools: [],
  contracts,
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
});

it.each([
  ["an approved review that included it", ["conversationAccess: read"], {}, undefined, true],
  ["an approved review without it", [], {}, undefined, false],
  [
    "a forged approval",
    ["conversationAccess: read"],
    { acceptedSurfaceHash: "0".repeat(64) },
    undefined,
    false,
  ],
  ["an explicit config denial", ["conversationAccess: read"], {}, false, false],
])(
  "grants conversation hooks to an installed plugin through %s",
  (_label, contracts, recordPatch, configured, granted) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "approved-reader",
      filename: "index.cjs",
      registration: `api.on("agent_end", () => undefined);`,
    });
    const acceptedSurface = surface(contracts);
    const install: PluginInstallRecord = {
      source: "npm",
      spec: "@vendor/approved-reader@1.0.0",
      installPath: plugin.dir,
      acceptedSurface,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
      ...recordPatch,
    };
    const registry = loadOpenClawPlugins({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            [plugin.id]: {
              enabled: true,
              ...(configured === undefined
                ? {}
                : { hooks: { allowConversationAccess: configured } }),
            },
          },
          slots: { memory: "none" },
        },
      },
      installRecords: { [plugin.id]: install },
      cache: false,
    });
    expect(registry.plugins.find(({ id }) => id === plugin.id)?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(
      granted ? ["agent_end"] : [],
    );
  },
);
