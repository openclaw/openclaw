import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => {
  resetConfigRuntimeState();
});

describe("config workspace plugin commit", () => {
  it("does not create workspace extension directories for a rejected write", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-commit-"));
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const workspace = path.join(home, "ops-workspace");
    const pluginPath = path.join(workspace, ".openclaw", "extensions");
    const source = { agents: { entries: { ops: { workspace } } } } satisfies OpenClawConfig;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(source)}\n`, "utf8");
    const io = createConfigIO({
      configPath,
      env: { HOME: home, OPENCLAW_TEST_FAST: "1" },
      homedir: () => home,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig = {
      agents: {
        ownership: "explicit" as const,
        entries: { ops: { workspace }, research: {} },
      },
    } satisfies OpenClawConfig;

    try {
      await expect(
        io.writeConfigFile(nextConfig, {
          baseSnapshot: snapshot,
          explicitSetPaths: [["agents"]],
          explicitSetValueSource: nextConfig,
          skipPluginValidation: true,
          preCommitRuntimePreflight: async () => {
            throw new Error("synthetic pre-commit rejection");
          },
        }),
      ).rejects.toThrow("synthetic pre-commit rejection");

      await expect(fs.access(pluginPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
