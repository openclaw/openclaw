import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root } from "@openclaw/fs-safe/root";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { sha256File } from "../../infra/directory-durability.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookSkillArtifact,
  PluginHookSkillChangedEvent,
} from "../../plugins/hook-types.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import type { CommittedSkillChange } from "./workspace-types.js";

const SKILL_FILE_CANDIDATES = ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"] as const;
const EXCLUDED_ROOT_DIRS = new Set([".clawhub", ".clawdhub", ".openclaw"]);

type CommittedSkillChangeSource = PluginHookSkillChangedEvent["source"];

type Logger = {
  warn?: (message: string) => void;
};

type SkillTreeFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

async function snapshotCommittedSkillArtifact(params: {
  skillDir: string;
  skillKey: string;
  source: CommittedSkillChangeSource;
  sourceVersion?: string;
}): Promise<PluginHookSkillArtifact> {
  const skillDir = path.resolve(params.skillDir);
  const skillRoot = await root(skillDir);
  const entries = await fs.readdir(skillDir, { withFileTypes: true });
  const selectedSkillPath = SKILL_FILE_CANDIDATES.find((candidate) =>
    entries.some((entry) => entry.name === candidate && entry.isFile()),
  );
  const files: SkillTreeFile[] = [];
  let selectedSkillFile: { file: SkillTreeFile; content: Buffer } | undefined;
  for await (const entry of skillRoot.walk("", {
    symlinkPolicy: "include",
    entryFilter: ({ relativePath }) =>
      EXCLUDED_ROOT_DIRS.has(relativePath) ? "skip-subtree" : "include",
  })) {
    if (entry.kind === "directory") {
      continue;
    }
    const portablePath = entry.relativePath;
    if (entry.kind !== "file") {
      throw new Error(`Skill tree contains unsupported entry ${JSON.stringify(portablePath)}.`);
    }
    // Listed names are literal; a leading "~" must not expand to the user's home.
    const opened = await skillRoot.open(`./${portablePath}`).catch((error: unknown) => {
      if (error instanceof FsSafeError && error.code === "hardlink") {
        throw new Error(`Skill tree contains hard-linked file ${JSON.stringify(portablePath)}.`, {
          cause: error,
        });
      }
      throw error;
    });
    try {
      const content =
        portablePath === selectedSkillPath ? await opened.handle.readFile() : undefined;
      const { digest, bytes } = content
        ? { digest: sha256Hex(content), bytes: content.byteLength }
        : await sha256File(opened.handle);
      const file = { path: portablePath, sha256: digest, sizeBytes: bytes };
      files.push(file);
      if (content) {
        selectedSkillFile = { file, content };
      }
    } finally {
      await opened.handle.close();
    }
  }
  if (!selectedSkillFile) {
    throw new Error(`Skill tree is missing SKILL.md: ${skillDir}`);
  }
  const skillFile = path.join(skillDir, selectedSkillFile.file.path);
  const frontmatter = parseSkillArtifactMetadata(selectedSkillFile.content);
  const treeSha256 = sha256Hex(JSON.stringify(files));
  return {
    name: frontmatter.name ?? params.skillKey,
    skillKey: params.skillKey,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    skillFile,
    skillDir,
    source: params.source,
    revision: {
      ...(frontmatter.declaredVersion ? { declaredVersion: frontmatter.declaredVersion } : {}),
      contentSha256: `sha256:${selectedSkillFile.file.sha256}`,
      treeSha256: `sha256:${treeSha256}`,
      ...(params.sourceVersion ? { sourceVersion: params.sourceVersion } : {}),
    },
  };
}

function parseSkillArtifactMetadata(content: Buffer): {
  name?: string;
  description?: string;
  declaredVersion?: string;
} {
  const text = content.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text, "utf8").equals(content)) {
    return {};
  }
  try {
    const frontmatter = parseSkillFrontmatter(text);
    return {
      name: normalizeOptionalString(frontmatter.name),
      description: normalizeOptionalString(frontmatter.description),
      declaredVersion: normalizeOptionalString(frontmatter.version),
    };
  } catch {
    return {};
  }
}

export function hasCommittedSkillChangeHooks(): boolean {
  return getGlobalHookRunner()?.hasHooks("skill_changed") ?? false;
}

export function resolveCommittedSkillChangeSource(
  originType: string | undefined,
): CommittedSkillChangeSource {
  if (originType === "clawhub") {
    return "clawhub";
  }
  if (originType === "upload") {
    return "upload";
  }
  return "source-install";
}

export async function snapshotCommittedSkillArtifactBestEffort(
  params: Parameters<typeof snapshotCommittedSkillArtifact>[0] & {
    logger?: Logger;
  },
): Promise<PluginHookSkillArtifact | undefined> {
  try {
    return await snapshotCommittedSkillArtifact(params);
  } catch (error) {
    params.logger?.warn?.(`Could not snapshot committed skill change: ${String(error)}`);
    return undefined;
  }
}

export async function dispatchCommittedSkillChangeBestEffort(
  params: CommittedSkillChange,
): Promise<void> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("skill_changed")) {
    return;
  }
  try {
    await runner.runSkillChanged(
      {
        action: params.action,
        source: params.source,
        occurredAt: new Date().toISOString(),
        ...(params.before ? { before: params.before } : {}),
        ...(params.after ? { after: params.after } : {}),
        ...(params.proposal ? { proposal: params.proposal } : {}),
      },
      { workspaceDir: params.workspaceDir },
    );
  } catch (error) {
    params.logger?.warn?.(`Committed skill change hook failed: ${String(error)}`);
  }
}
