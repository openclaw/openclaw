import fs from "node:fs/promises";
import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * `load_skill` — read-only, name-scoped access to the agent's live skills for
 * APP-USER sessions.
 *
 * App-user sessions run jailed (`tools.fs.workspaceOnly`), so they cannot `read`
 * a shared `workspace/skills/<name>/SKILL.md` by path even though that skill is
 * listed in their prompt. This tool resolves a skill NAME — from the SAME set the
 * model is shown: the prompt-LIMITED subset of `SkillSnapshot.resolvedSkills` (after
 * `limitAppSkills` applies the `maxSkillsInPrompt` / char caps) — to its `SKILL.md`
 * content, read server-side (the gateway process is not jailed). The model never
 * supplies a path, so there is no traversal surface, and the allowlist is exactly
 * the visible set, so it is never a side channel to filtered /
 * `disableModelInvocation` / out-of-prompt / over-limit skills.
 *
 * Plan: docs/experiments/plans/app-user-skill-access.md (Option A); codex review
 * 4517821566.
 */

/** Hard byte cap on returned SKILL.md content (context budget + defence-in-depth). */
export const LOAD_SKILL_MAX_BYTES = 24 * 1024;

/**
 * Bound `content` to {@link LOAD_SKILL_MAX_BYTES} on a UTF-8 byte boundary,
 * dropping a truncated trailing multi-byte char (mirrors `clampAppProfile`).
 */
export function clampSkillContent(content: string, maxBytes = LOAD_SKILL_MAX_BYTES): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  let s = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
  if (s.endsWith("�")) {
    s = s.slice(0, -1);
  }
  return s;
}

export type LoadSkillResult =
  | { ok: true; name: string; description: string; content: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Resolve a skill by exact (trimmed) name from a trusted allowlist and read its
 * `SKILL.md`. Confines the read to the matched entry's OWN `baseDir` — a
 * prompt-visible skill may legitimately live under any merged root
 * (bundled/managed/workspace), so we trust the enumerator's resolved root, not a
 * hardcoded dir (codex 4517821566 #1) — and rejects a symlinked `SKILL.md` that
 * escapes that root. The model passes only a name; there is no path input.
 */
export async function readSkillByName(
  skills: readonly Skill[],
  rawName: string,
): Promise<LoadSkillResult> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const match = skills.find((s) => s.name === name);
  if (!match) {
    const available = skills.map((s) => s.name).join(", ");
    return { ok: false, error: `unknown skill "${name}"; available: ${available || "(none)"}` };
  }
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fs.realpath(match.baseDir);
    realFile = await fs.realpath(match.filePath);
  } catch {
    return { ok: false, error: `skill "${name}" is not readable` };
  }
  const rel = path.relative(realRoot, realFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `skill "${name}" resolved outside its directory` };
  }
  let raw: string;
  try {
    raw = await fs.readFile(realFile, "utf-8");
  } catch {
    return { ok: false, error: `skill "${name}" could not be read` };
  }
  const content = clampSkillContent(raw);
  return {
    ok: true,
    name: match.name,
    description: match.description ?? "",
    content,
    truncated: Buffer.byteLength(raw, "utf8") > Buffer.byteLength(content, "utf8"),
  };
}

const LoadSkillSchema = Type.Object({
  name: Type.String({
    description: "The exact <name> of a skill listed in <available_skills>.",
  }),
});

/**
 * Build the `load_skill` tool from the app session's allowlist — the prompt-limited
 * subset of the snapshot's `resolvedSkills` (via `limitAppSkills`). Returns null
 * when there is no allowlist — non-app
 * sessions never pass `skills` (the gating, including the resolved-app-user check,
 * lives at the call site in `attempt.ts`). Read-only.
 */
export function createLoadSkillTool(options: { skills?: readonly Skill[] }): AnyAgentTool | null {
  const skills = options.skills;
  if (!skills || skills.length === 0) {
    return null;
  }
  return {
    label: "Load Skill",
    name: "load_skill",
    description:
      "Load the full instructions (SKILL.md) for one of the skills listed in <available_skills>, by its exact <name>. Call this when a listed skill matches the task, then follow what it says. Read-only.",
    parameters: LoadSkillSchema,
    execute: async (_toolCallId, params) => {
      const name = readStringParam(params, "name", { required: true });
      const result = await readSkillByName(skills, name);
      return jsonResult(result);
    },
  };
}
