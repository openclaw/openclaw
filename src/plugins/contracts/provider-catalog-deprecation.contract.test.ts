import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const CODE_MODE_TIER_LITERAL = /codeMode:\s*"(?:preferred|capable)"/;
// Minimax resolves cost per provider surface, so its rows cannot live in one
// manifest catalog and remain invisible to the manifest scan below.
const UNCONVERTED_SOURCE_CATALOG_PLUGINS = ["minimax"];

type CatalogEntry = {
  ref: string;
  groupKey: string;
  upstreamModel?: string;
  codeMode?: string;
};

function listBundledPluginFiles(): string[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" });
  if (!files) {
    throw new Error("unable to list bundled plugin files from git");
  }
  return files;
}

function readManifests() {
  return listBundledPluginFiles()
    .filter((file) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file))
    .map(
      (file) =>
        [
          file,
          JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Record<string, unknown>,
        ] as const,
    );
}

// Group aggregator aliases with first-party rows, ignoring namespace and case.
function normalizeSharedModelId(modelId: string): string {
  return modelId.slice(modelId.indexOf("/") + 1).toLowerCase();
}

function collectCatalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [, manifest] of readManifests()) {
    const providers = readRecord(readRecord(manifest.modelCatalog)?.providers) ?? {};
    // CLI backends run their own harness, so catalog code-mode tiers never reach them.
    const cliBackends = new Set(
      Array.isArray(manifest.cliBackends) ? (manifest.cliBackends as string[]) : [],
    );
    for (const [providerId, provider] of Object.entries(providers)) {
      if (cliBackends.has(providerId)) {
        continue;
      }
      const models = readRecord(provider)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const rawModel of models) {
        const model = readRecord(rawModel);
        const id = typeof model?.id === "string" ? model.id : undefined;
        if (!id) {
          continue;
        }
        const upstreamModel =
          typeof model?.upstreamModel === "string" ? model.upstreamModel : undefined;
        const codeMode = readRecord(model?.compat)?.codeMode;
        entries.push({
          ref: `${providerId}/${id}`,
          groupKey: normalizeSharedModelId(
            upstreamModel ? upstreamModel.slice(upstreamModel.indexOf("/") + 1) : id,
          ),
          ...(upstreamModel ? { upstreamModel } : {}),
          ...(typeof codeMode === "string" ? { codeMode } : {}),
        });
      }
    }
  }
  return entries;
}

describe("bundled shared upstream model catalogs", () => {
  // Read lazily: the non-isolated contract runner shares one process, so manifest
  // IO belongs inside the tests rather than in collection.
  let cached: CatalogEntry[] | undefined;
  const readEntries = (): CatalogEntry[] => (cached ??= collectCatalogEntries());

  it("resolves every declared upstream model ref to another bundled catalog row", () => {
    const entries = readEntries();
    const refs = new Set(entries.map((entry) => entry.ref));
    const unresolved = entries
      .filter(
        ({ upstreamModel, ref }) =>
          upstreamModel && (upstreamModel === ref || !refs.has(upstreamModel)),
      )
      .map(({ ref, upstreamModel }) => `${ref} -> ${upstreamModel}`)
      .toSorted();

    expect(unresolved).toEqual([]);
  });

  it("declares the code-mode tier on every catalog row that ships a shared model", () => {
    // A silent sibling would change tools.codeMode: "auto" for the same model.
    const silent: string[] = [];
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of readEntries()) {
      const group = groups.get(entry.groupKey);
      if (group) {
        group.push(entry);
      } else {
        groups.set(entry.groupKey, [entry]);
      }
    }
    for (const [groupKey, group] of groups) {
      if (group.length < 2 || !group.some((entry) => entry.codeMode)) {
        continue;
      }
      for (const entry of group.filter((candidate) => !candidate.codeMode)) {
        silent.push(`${entry.ref} (shared model ${groupKey})`);
      }
    }

    expect(silent.toSorted()).toEqual([]);
  });

  it("keeps code-mode tiers out of plugin source so shared-model checks can see them", () => {
    const plugins = listBundledPluginFiles()
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .filter((file) =>
        CODE_MODE_TIER_LITERAL.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
      )
      .map((file) => file.split("/")[1] as string);

    expect([...new Set(plugins)].toSorted()).toEqual(UNCONVERTED_SOURCE_CATALOG_PLUGINS);
  });
});

describe("bundled channel-provider skill contracts", () => {
  const configured = (plugin: "discord" | "slack", named = false): OpenClawConfig => {
    const credentials =
      plugin === "discord"
        ? { token: "test-discord-token" }
        : { botToken: "xoxb-test-token", appToken: "xapp-test-token" };
    return { channels: { [plugin]: named ? { accounts: { support: credentials } } : credentials } };
  };
  type SkillCase = [string, "discord" | "slack", OpenClawConfig, boolean, boolean?];
  it.each<SkillCase>([
    ["Discord named-account token", "discord", configured("discord", true), true],
    ["Discord root token", "discord", configured("discord"), true],
    ["Discord unconfigured", "discord", {}, false],
    [
      "Discord explicitly disabled",
      "discord",
      {
        ...configured("discord"),
        skills: { entries: { discord: { enabled: false } } },
      },
      false,
      true,
    ],
    ["Slack named-account credentials", "slack", configured("slack", true), true],
  ])("%s", async (_label, pluginId, config, eligible, disabled = false) => {
    const workspaceDir = path.join(repoRoot, "extensions", pluginId);
    const entries = loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config,
      entries,
      managedSkillsDir: path.join(workspaceDir, "skills"),
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
    const files = listBundledPluginFiles();
    const skills = readManifests().flatMap(([file, manifest]) => {
      if (!Array.isArray(manifest.channels) || !Array.isArray(manifest.skills)) {
        return [];
      }
      return manifest.skills.flatMap((root) => {
        if (typeof root !== "string" || root.includes("node_modules")) {
          return [];
        }
        const prefix = path
          .relative(repoRoot, path.resolve(repoRoot, path.dirname(file), root))
          .replaceAll("\\", "/");
        return files.filter(
          (candidate) => candidate.startsWith(`${prefix}/`) && candidate.endsWith(".md"),
        );
      });
    });
    const retired = [
      /use\s+the\s+[`'"]slack[`'"]\s+tool/iu,
      /["']action["']\s*:\s*["'](?:sendMessage|readMessages|editMessage|deleteMessage|pinMessage|unpinMessage|listPins|memberInfo|emojiList)["']/u,
      /owner_open_id/u,
      /feishu_doc_list_blocks/u,
      /feishu_doc_update_block/u,
      /feishu_doc_delete_block/u,
      /["']components["']\s*:\s*["']\[Carbon v2 components\]["']/u,
      /## 备用方案（直接使用 `cron` 工具）/u,
      /github\.com\/steipete\/wacli\/cmd\/wacli@latest/u,
    ];
    expect(skills.length).toBeGreaterThan(0);
    const failures = [...new Set(skills)].flatMap((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return retired
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: retired contract ${pattern.source}`);
    });
    expect(failures).toStrictEqual([]);
  });
});
