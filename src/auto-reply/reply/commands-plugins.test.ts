import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-plugins-"));
  tempDirs.push(dir);
  return dir;
}

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
    commands: {
      text: true,
      plugins: true,
    },
  };
}

describe("handleCommands /plugins", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("lists discovered plugins and shows plugin details", async () => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await createWorkspace();
      await createClaudeBundlePlugin({ workspaceDir, pluginId: "superpowers" });

      const listParams = buildCommandTestParams("/plugins list", buildCfg(), undefined, {
        workspaceDir,
      });
      listParams.command.senderIsOwner = true;
      const listResult = await handleCommands(listParams);
      expect(listResult.reply?.text).toContain("Plugins");
      expect(listResult.reply?.text).toContain("superpowers");
      expect(listResult.reply?.text).toContain("[disabled]");

      const showParams = buildCommandTestParams("/plugin show superpowers", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const showResult = await handleCommands(showParams);
      expect(showResult.reply?.text).toContain('"id": "superpowers"');
      expect(showResult.reply?.text).toContain('"bundleFormat": "claude"');
    });
  });

  it("enables and disables a discovered plugin", async () => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await createWorkspace();
      await createClaudeBundlePlugin({ workspaceDir, pluginId: "superpowers" });

      const enableParams = buildCommandTestParams(
        "/plugins enable superpowers",
        buildCfg(),
        undefined,
        {
          workspaceDir,
        },
      );
      enableParams.command.senderIsOwner = true;
      const enableResult = await handleCommands(enableParams);
      expect(enableResult.reply?.text).toContain('Plugin "superpowers" enabled');

      const showEnabledParams = buildCommandTestParams(
        "/plugins show superpowers",
        buildCfg(),
        undefined,
        {
          workspaceDir,
        },
      );
      showEnabledParams.command.senderIsOwner = true;
      const showEnabledResult = await handleCommands(showEnabledParams);
      expect(showEnabledResult.reply?.text).toContain('"status": "loaded"');
      expect(showEnabledResult.reply?.text).toContain('"enabled": true');

      const disableParams = buildCommandTestParams(
        "/plugins disable superpowers",
        buildCfg(),
        undefined,
        {
          workspaceDir,
        },
      );
      disableParams.command.senderIsOwner = true;
      const disableResult = await handleCommands(disableParams);
      expect(disableResult.reply?.text).toContain('Plugin "superpowers" disabled');
    });
  });

  it("rejects internal writes without operator.admin", async () => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await createWorkspace();
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
