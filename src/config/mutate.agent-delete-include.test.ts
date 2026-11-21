import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.factory.js";
import { replaceConfigFile } from "./mutate.js";
import { resetConfigRuntimeState } from "./runtime-snapshot.js";

describe("agent deletion through a whole-map entries include", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-agent-delete-include-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(() => {
    resetConfigRuntimeState();
  });

  it("removes the entry from the include and leaves the root config unchanged", async () => {
    const home = await suiteRootTracker.make("whole-map-entries-delete");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const entriesPath = path.join(home, ".openclaw", "entries.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const rootRaw = JSON.stringify({
      agents: { ownership: "explicit", entries: { $include: "./entries.json5" } },
    });
    await fs.writeFile(configPath, rootRaw);
    await fs.writeFile(
      entriesPath,
      JSON.stringify({
        main: { workspace: "/srv/workspace" },
        other: { workspace: "/srv/workspace-other" },
        doomed: { workspace: "/srv/workspace-doomed" },
      }),
    );
    const configIO = createConfigIO({
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      observe: false,
      pluginValidation: "skip",
    });
    const { snapshot, writeOptions } = await configIO.readConfigFileSnapshotForWrite();
    const { config: nextConfig } = pruneAgentConfig(snapshot.sourceConfig, "doomed");

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions,
      nextConfig,
      io: {
        readConfigFileSnapshotForWrite: () => configIO.readConfigFileSnapshotForWrite(),
        writeConfigFile: (config, options) => configIO.writeConfigFile(config, options),
      },
    });

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
    expect(JSON.parse(await fs.readFile(entriesPath, "utf-8"))).toEqual({
      main: { workspace: "/srv/workspace" },
      other: { workspace: "/srv/workspace-other" },
    });
  });
});
