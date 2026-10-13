import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { sha256File, sha256Hex } from "../../infra/crypto-digest.js";

const EXCLUDED_METADATA_DIRS = new Set([".clawhub", ".clawdhub"]);

type SkillTreeEntry = {
  path: string;
  sha256?: string;
  type: "directory" | "file";
};

/** Digests every installed skill file except OpenClaw's own provenance metadata. */
export async function digestClawHubSkillTree(skillDir: string): Promise<string> {
  const scoped = await root(skillDir);
  const collected: SkillTreeEntry[] = [];
  for await (const entry of scoped.walk("", {
    symlinkPolicy: "include",
    entryFilter: ({ relativePath }) =>
      EXCLUDED_METADATA_DIRS.has(relativePath) ? "skip-subtree" : "include",
  })) {
    const portablePath = entry.relativePath;
    const stat = await fs.lstat(path.join(skillDir, portablePath));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Skill tree contains unsupported entry ${JSON.stringify(portablePath)}.`);
    }
    if (stat.isDirectory()) {
      collected.push({ path: portablePath, type: "directory" });
      continue;
    }
    if (stat.nlink > 1) {
      throw new Error(`Skill tree contains hard-linked file ${JSON.stringify(portablePath)}.`);
    }
    // Bound nonempty files to their initial size so appends cannot prolong hashing.
    // Empty files retain readFile's EOF behavior.
    const end = stat.size > 0 ? stat.size - 1 : undefined;
    collected.push({
      path: portablePath,
      type: "file",
      sha256: await sha256File(path.join(skillDir, portablePath), end),
    });
  }
  return `sha256:${sha256Hex(JSON.stringify(collected))}`;
}

/** File fingerprints captured before a ClawHub update or removal. */
export type ClawHubSkillFileState = {
  slug: string;
  skillFilePath: string;
  skillFileSha256: string;
  fileTreeSha256: string;
};

export async function checkClawHubSkillPlanAtPath(
  plan: ClawHubSkillFileState,
  skillDir: string,
  readFile: typeof fs.readFile = fs.readFile,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const stat = await fs.lstat(skillDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: `Skill ${JSON.stringify(plan.slug)} changed during update.` };
    }
    const content = await readFile(path.join(skillDir, plan.skillFilePath));
    if (
      sha256Hex(content) !== plan.skillFileSha256 ||
      (await digestClawHubSkillTree(skillDir)) !== plan.fileTreeSha256
    ) {
      return { ok: false, error: `Skill ${JSON.stringify(plan.slug)} changed during update.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
