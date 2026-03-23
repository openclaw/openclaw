import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { handleCommands } from "./commands-core.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-");

async function createClaudeBundlePlugin(params: { workspaceDir: string; pluginId: string }) {
  const pluginDir = path.join(params.workspaceDir, ".openclaw", "extensions", params.pluginId);
  await fs.mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(pluginDir, "commands"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: params.pluginId }, null, 2),
    "utf-8",
  );
  await fs.writeFile(path.join(pluginDir, "commands", "review.md"), "# Review\n", "utf-8");
}

function buildCfg(): OpenClawConfig {
  return {
    plugins: {
      enabled: true,
    },
    commands: {
      text: true,
      plugins: true,
    },
  };
}

describe("handleCommands /plugins", () => {
  afterEach(async () => {
    await workspaceHarness.cleanupWorkspaces();
  });

  it("lists discovered plugins and inspects plugin details", async () => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      await createClaudeBundlePlugin({ workspaceDir, pluginId: "superpowers" });

      const listParams = buildCommandTestParams("/plugins list", buildCfg(), undefined, {
        workspaceDir,
      });
      listParams.command.senderIsOwner = true;
      const listResult = await handleCommands(listParams);
      expect(listResult.reply?.text).toContain("Plugins");
      expect(listResult.reply?.text).toContain("superpowers");
      expect(listResult.reply?.text).toContain("[disabled]");

      const showParams = buildCommandTestParams(
        "/plugins inspect superpowers",
        buildCfg(),
        undefined,
        {
          workspaceDir,
        },
      );
      showParams.command.senderIsOwner = true;
      const showResult = await handleCommands(showParams);
      expect(showResult.reply?.text).toContain('"id": "superpowers"');
      expect(showResult.reply?.text).toContain('"bundleFormat": "claude"');
      expect(showResult.reply?.text).toContain('"shape":');
      expect(showResult.reply?.text).toContain('"compatibilityWarnings": []');

      const inspectAllParams = buildCommandTestParams(
        "/plugins inspect all",
        buildCfg(),
        undefined,
        {
          workspaceDir,
        },
      );
      inspectAllParams.command.senderIsOwner = true;
      const inspectAllResult = await handleCommands(inspectAllParams);
      expect(inspectAllResult.reply?.text).toContain("```json");
      expect(inspectAllResult.reply?.text).toContain('"plugin"');
      expect(inspectAllResult.reply?.text).toContain('"compatibilityWarnings"');
      expect(inspectAllResult.reply?.text).toContain('"superpowers"');
    });
  });

  it("rejects internal writes without operator.admin", async () => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      await createClaudeBundlePlugin({ workspaceDir, pluginId: "superpowers" });

      const params = buildCommandTestParams(
        "/plugins enable superpowers",
        buildCfg(),
        {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: ["operator.write"],
        },
        { workspaceDir },
      );
      params.command.senderIsOwner = true;

      const result = await handleCommands(params);
      expect(result.reply?.text).toContain("requires operator.admin");
    });
  });
});
