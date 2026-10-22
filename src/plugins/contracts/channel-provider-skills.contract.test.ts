import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

type PluginManifest = {
  channels?: unknown;
  skills?: unknown;
};

const RETIRED_SKILL_PATTERNS = [
  /use\s+the\s+[`'"]slack[`'"]\s+tool/iu,
  /["']action["']\s*:\s*["'](?:sendMessage|readMessages|editMessage|deleteMessage|pinMessage|unpinMessage|listPins|memberInfo|emojiList)["']/u,
  /owner_open_id/u,
  /feishu_doc_list_blocks/u,
  /feishu_doc_update_block/u,
  /feishu_doc_delete_block/u,
  /["']components["']\s*:\s*["']\[Carbon v2 components\]["']/u,
  /## 备用方案（直接使用 `cron` 工具）/u,
  /github\.com\/steipete\/wacli\/cmd\/wacli@latest/u,
] as const;

function listRepositoryOwnedChannelSkillFiles(): string[] {
  const trackedFiles = listGitTrackedFiles({ pathspecs: ["extensions"] }) ?? [];
  const files = trackedFiles
    .filter((file) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(file))
    .flatMap((manifestPath) => {
      const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as PluginManifest;
      if (!Array.isArray(manifest.channels) || !Array.isArray(manifest.skills)) {
        return [];
      }
      return manifest.skills.flatMap((skillRoot) => {
        if (typeof skillRoot !== "string" || skillRoot.includes("node_modules")) {
          return [];
        }
        const root = relative(process.cwd(), resolve(dirname(manifestPath), skillRoot)).replaceAll(
          "\\",
          "/",
        );
        return trackedFiles.filter((file) => file.startsWith(`${root}/`) && file.endsWith(".md"));
      });
    });
  return [...new Set(files)].toSorted();
}

describe("bundled channel-provider skill contracts", () => {
  const discord = (namedAccount = false): OpenClawConfig => ({
    channels: {
      discord: namedAccount
        ? { accounts: { support: { token: "test-discord-token" } } }
        : { token: "test-discord-token" },
    },
  });
  type SkillCase = [string, "discord" | "slack", OpenClawConfig, boolean, boolean?];
  it.each<SkillCase>([
    ["Discord named-account token", "discord", discord(true), true],
    ["Discord root token", "discord", discord(), true],
    ["Discord unconfigured", "discord", {}, false],
    [
      "Discord explicitly disabled",
      "discord",
      { ...discord(), skills: { entries: { discord: { enabled: false } } } },
      false,
      true,
    ],
    [
      "Slack named-account credentials",
      "slack",
      {
        channels: {
          slack: {
            accounts: {
              support: { botToken: "xoxb-test-token", appToken: "xapp-test-token" },
            },
          },
        },
      },
      true,
    ],
  ])("%s", async (_label, pluginId, config, eligible, disabled = false) => {
    const workspaceDir = resolve(process.cwd(), "extensions", pluginId);
    // Load the shipped asset without discovering operator skills or activating plugin runtimes.
    const entries = loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config,
      entries,
      managedSkillsDir: resolve(workspaceDir, "skills"),
    });
    expect(report.skills.find((skill) => skill.name === pluginId)).toMatchObject({
      eligible,
      disabled,
      modelVisible: eligible,
    });

    const snapshot = await buildSkillSnapshot(workspaceDir, { config, entries });
    expect(snapshot.prompt.includes(`<name>${pluginId}</name>`)).toBe(eligible);
  });

  it("does not teach retired tool, action, parameter, or install contracts", () => {
    const failures: string[] = [];
    const skillFiles = listRepositoryOwnedChannelSkillFiles();

    expect(skillFiles.length).toBeGreaterThan(0);
    for (const file of skillFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const pattern of RETIRED_SKILL_PATTERNS) {
        if (pattern.test(source)) {
          failures.push(`${file}: retired contract ${pattern.source}`);
        }
      }
    }

    expect(failures).toStrictEqual([]);
  });
});
