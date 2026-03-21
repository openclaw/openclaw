import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { loadEnabledClaudeBundleCommands } from "./bundle-commands.js";
import { createBundleMcpTempHarness } from "./bundle-mcp.test-support.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

describe("loadEnabledClaudeBundleCommands", () => {
  it("loads enabled Claude bundle markdown commands and skips disabled-model-invocation entries", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-bundle-commands-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-bundle-commands-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "compound-bundle");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "commands", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "compound-bundle" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, "commands", "office-hours.md"),
        [
          "---",
          "description: Help with scoping and architecture",
          "---",
          "Give direct engineering advice.",
          "",
        ].join("\n"),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, "commands", "workflows", "review.md"),
        [
          "---",
          "name: workflows:review",
          "description: Run a structured review",
          "---",
          "Review the code. $ARGUMENTS",
          "",
        ].join("\n"),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, "commands", "disabled.md"),
        ["---", "disable-model-invocation: true", "---", "Do not load me.", ""].join("\n"),
        "utf-8",
      );

      const commands = loadEnabledClaudeBundleCommands({
        workspaceDir,
        cfg: {
          plugins: {
            entries: {
              "compound-bundle": { enabled: true },
            },
          },
        },
      });

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: "compound-bundle",
            rawName: "office-hours",
            description: "Help with scoping and architecture",
            promptTemplate: "Give direct engineering advice.",
          }),
          expect.objectContaining({
            pluginId: "compound-bundle",
            rawName: "workflows:review",
            description: "Run a structured review",
            promptTemplate: "Review the code. $ARGUMENTS",
          }),
        ]),
      );
      expect(commands.some((entry) => entry.rawName === "disabled")).toBe(false);
    } finally {
      env.restore();
    }
  });
});
