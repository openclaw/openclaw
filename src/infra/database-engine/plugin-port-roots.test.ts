import path from "node:path";
import { expect, it } from "vitest";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { logbookPortProvider } from "./logbook-port.js";
import { teamReportsPortProvider } from "./team-reports-port.js";
import { workboardPortProvider } from "./workboard-port.js";

function plugin(
  id: string,
  backupResources?: PluginManifestRecord["backupResources"],
): PluginManifestRecord {
  return {
    id,
    backupResources,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/synthetic/plugin",
    source: "/synthetic/plugin/index.ts",
    manifestPath: "/synthetic/plugin/openclaw.plugin.json",
  };
}

it.each([
  {
    provider: workboardPortProvider,
    expected: ["first.sqlite", "frames", "upper.SQLITE", "first.sqlite", "last.sqlite"],
  },
  {
    provider: teamReportsPortProvider,
    expected: ["first.sqlite", "frames", "upper.SQLITE", "first.sqlite", "last.sqlite"],
  },
  { provider: logbookPortProvider, expected: ["first.sqlite", "first.sqlite", "last.sqlite"] },
])(
  "discovers only included $provider.id state resources in metadata order",
  async ({ provider, expected }) => {
    const stateDir = path.resolve("/synthetic/state");
    const roots = await provider.resolveRoots({
      config: {},
      stateDir,
      env: {},
      plugins: {
        plugins: [
          plugin("unrelated", [
            { disposition: "include", scope: "state", relativePath: "foreign.sqlite" },
          ]),
          plugin(provider.id),
          plugin(provider.id, [
            { disposition: "include", scope: "state", relativePath: "first.sqlite" },
            { disposition: "regenerable", scope: "state", relativePath: "scratch.sqlite" },
            { disposition: "include", scope: "agent", relativePath: "agent.sqlite" },
            { disposition: "include", scope: "state", relativePath: "frames" },
            { disposition: "include", scope: "state", relativePath: "upper.SQLITE" },
            { disposition: "include", scope: "state", relativePath: "first.sqlite" },
          ]),
          plugin(provider.id, [
            { disposition: "include", scope: "state", relativePath: "last.sqlite" },
          ]),
        ],
      },
    });
    expect(roots).toEqual(expected.map((file) => path.join(stateDir, file)));
  },
);
