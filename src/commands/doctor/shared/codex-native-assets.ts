// Doctor scan for personal Codex CLI assets that native Codex-mode agents do not auto-load.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord as hasRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { collectConfiguredAgentHarnessRuntimes } from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type CodexNativeAssetHit = {
  /** Native Codex asset category discovered under Codex or personal agent homes. */
  kind: "skill" | "plugin" | "config" | "hooks";
  /** Absolute path to the asset or asset container. */
  path: string;
};

const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2000;

function resolveUserHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

function resolveHomePath(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~") {
    return resolveUserHome(env);
  }
  if (value.startsWith("~/")) {
    return path.join(resolveUserHome(env), value.slice(2));
  }
  return path.resolve(value);
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return resolveHomePath(env.CODEX_HOME?.trim() || "~/.codex", env);
}

function resolvePersonalAgentSkillsDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveUserHome(env), ".agents", "skills");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverDirectoryAssets(
  root: string,
  kind: "skill" | "plugin",
): Promise<CodexNativeAssetHit[]> {
  if (!(await isDirectory(root))) {
    return [];
  }
  const hits: CodexNativeAssetHit[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (hits.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    if (kind === "skill" && depth === 1 && path.basename(dir) === ".system") {
      // Built-in Codex system skills are not user assets that migration should promote.
      return;
    }
    const marker =
      kind === "skill"
        ? path.join(dir, "SKILL.md")
        : path.join(dir, ".codex-plugin", "plugin.json");
    if (await exists(marker)) {
      hits.push({ kind, path: dir });
      return;
    }
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  return hits;
}

function isCodexPluginConfigured(cfg: OpenClawConfig): boolean {
  const plugins = cfg.plugins;
  if (plugins?.enabled === false) {
    return false;
  }
  const allow = plugins?.allow;
  const allowList = Array.isArray(allow) ? allow.map((entry) => normalizeString(entry)) : undefined;
  if (allowList) {
    return allowList.includes("codex");
  }
  return hasRecord(plugins?.entries?.codex) && plugins.entries.codex.enabled !== false;
}

/** Discover personal Codex skills, plugins, config, and hooks relevant to Codex-mode agents. */
async function scanCodexNativeAssets(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexNativeAssetHit[]> {
  const env = params.env ?? process.env;
  if (
    !collectConfiguredAgentHarnessRuntimes(params.cfg).includes("codex") &&
    !isCodexPluginConfigured(params.cfg)
  ) {
    return [];
  }
  const codexHome = resolveCodexHome(env);
  const hits = new Map<string, CodexNativeAssetHit>();
  function record(hit: CodexNativeAssetHit): void {
    hits.set(`${hit.kind}:${hit.path}`, hit);
  }
  for (const [resolveRoot, kind] of [
    [() => path.join(codexHome, "skills"), "skill"],
    [() => resolvePersonalAgentSkillsDir(env), "skill"],
    [() => path.join(codexHome, "plugins", "cache"), "plugin"],
  ] as const) {
    for (const hit of await discoverDirectoryAssets(resolveRoot(), kind)) {
      record(hit);
    }
  }
  for (const [kind, relativePath] of [
    ["config", "config.toml"],
    ["hooks", path.join("hooks", "hooks.json")],
  ] as const) {
    const assetPath = path.join(codexHome, relativePath);
    if (await exists(assetPath)) {
      record({ kind, path: assetPath });
    }
  }
  return [...hits.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

/** Build an informational doctor note when personal Codex CLI assets need migration review. */
export async function collectCodexNativeAssetInfoNotes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const env = params.env ?? process.env;
  const hits = await scanCodexNativeAssets({ cfg: params.cfg, env });
  if (hits.length === 0) {
    return [];
  }
  const counts = (
    [
      ["skill", "skill"],
      ["plugin", "plugin"],
      ["config", "config file"],
      ["hooks", "hook file"],
    ] as const
  ).map(([kind, label]) => {
    const count = hits.filter((hit) => hit.kind === kind).length;
    return `${count} ${label}${count === 1 ? "" : "s"}`;
  });
  return [
    [
      `- Personal Codex CLI assets found (${counts.join(", ")}) in ${resolveCodexHome(env)} and ${resolvePersonalAgentSkillsDir(env)}; native Codex-mode agents use isolated per-agent homes and will not load them.`,
      "- To review or promote them: install the Codex plugin (openclaw plugins install npm:@openclaw/codex), then run openclaw migrate plan codex.",
    ].join("\n"),
  ];
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.codexNativeAssetsTestApi")] = {
    scanCodexNativeAssets,
  };
}
