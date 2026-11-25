import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { collectCodexNativeAssetInfoNotes } from "./codex-native-assets.js";
import { scanCodexNativeAssets } from "./codex-native-assets.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function codexConfig(): OpenClawConfigWithLegacyRoster {
  return {
    plugins: { entries: { codex: { enabled: true } } },
    agents: { defaults: { agentRuntime: { id: "codex" } } },
  };
}

let root: string;
let codexHome: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = tempDirs.make("openclaw-doctor-codex-assets-");
  codexHome = path.join(root, ".codex");
  env = { CODEX_HOME: codexHome, HOME: root };
});

describe("scanCodexNativeAssets", () => {
  it("finds personal Codex CLI assets that isolated agents will not load implicitly", async () => {
    for (const file of [
      ".codex/skills/tweet-helper/SKILL.md",
      ".agents/skills/agent-helper/SKILL.md",
      ".codex/skills/.system/system-skill/SKILL.md",
      ".codex/config.toml",
      ".codex/hooks/hooks.json",
    ]) {
      await writeFile(path.join(root, file));
    }
    const plugin = ".codex/plugins/cache/openai-primary-runtime/documents/1.0.0";
    await writeFile(path.join(root, plugin, ".codex-plugin/plugin.json"), "{}");
    const hits = await scanCodexNativeAssets({ cfg: codexConfig(), env });
    expect(
      hits.map((hit) => [hit.kind, path.relative(root, hit.path).split(path.sep).join("/")]),
    ).toEqual([
      ["skill", ".agents/skills/agent-helper"],
      ["config", ".codex/config.toml"],
      ["hooks", ".codex/hooks/hooks.json"],
      ["plugin", plugin],
      ["skill", ".codex/skills/tweet-helper"],
    ]);
  });

  it("does not scan when Codex is not configured", async () => {
    await writeFile(path.join(codexHome, "skills", "tweet-helper", "SKILL.md"));
    await writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"));

    await expect(scanCodexNativeAssets({ cfg: {}, env })).resolves.toStrictEqual([]);
  });
});

describe("collectCodexNativeAssetInfoNotes", () => {
  it("points users at explicit Codex migration planning", async () => {
    await writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"));

    const notes = await collectCodexNativeAssetInfoNotes({ cfg: codexConfig(), env });

    expect(notes).toStrictEqual([
      [
        `- Personal Codex CLI assets found (1 skill, 0 plugins, 0 config files, 0 hook files) in ${codexHome} and ${path.join(root, ".agents", "skills")}; native Codex-mode agents use isolated per-agent homes and will not load them.`,
        "- To review or promote them: install the Codex plugin (openclaw plugins install npm:@openclaw/codex), then run openclaw migrate plan codex.",
      ].join("\n"),
    ]);
  });

  it("returns empty when no Codex assets are found", async () => {
    const notes = await collectCodexNativeAssetInfoNotes({ cfg: codexConfig(), env });

    expect(notes).toStrictEqual([]);
  });
});
