import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import { decodeSkillXml } from "../skills/loading/skill-contract.js";
import { parseSkillsPromptCatalog } from "../skills/loading/skill-prompt-catalog.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "./tool-catalog.js";

// `skills_read(name)` resolves by name, so path-based loading prose and `<location>` only cost context.
// Matches the one-tag-per-line shape that `formatSkillCatalog` in skill-contract.ts renders.
const CATALOG_INTRO =
  /^The following skills provide[^\n]*\n[^\n]*\nWhen a skill file references[^\n]*\n\n/mu;
const CATALOG_ENTRY =
  /^ {2}<skill>\n {4}<name>(.*)<\/name>\n(?: {4}<description>([\s\S]*?)<\/description>\n)? {4}<location>.*<\/location>\n(?: {4}<location_note>(.*)<\/location_note>\n)? {2}<\/skill>$/gmu;
// Names are JSON-quoted and byte-exact: `skills_read` matches them with === and any character
// (including `: ` or ` (`) may appear in one. Only prose is whitespace-folded.
const prose = (value: string) => decodeSkillXml(value).replace(/\s+/gu, " ").trim();

/** Idempotent: an already-compact catalog has no XML entries to rewrite. */
export function compactCatalogForSkillRead(skillsPrompt: string): string {
  return skillsPrompt
    .replace(CATALOG_INTRO, "")
    .replace(
      CATALOG_ENTRY,
      (_match, name: string, desc?: string, note?: string) =>
        `- ${JSON.stringify(decodeSkillXml(name))}${desc ? `: ${prose(desc)}` : ""}${note ? ` (${prose(note)})` : ""}`,
    );
}

export function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
  codeModeActive?: boolean;
  promptSurface: AgentPromptSurfaceKind;
  availableTools: ReadonlySet<string>;
  visibleTools: ReadonlyMap<string, string>;
  deferredToolsDirectlyCallable?: boolean;
}) {
  const { availableTools, visibleTools } = params;
  const installedSkillRead = availableTools.has("skills_read");
  // CLI backends own native file tools outside OpenClaw's projected tool list.
  const canAccess = params.codeModeActive
    ? visibleTools.has("exec") && installedSkillRead
    : visibleTools.has("read") || installedSkillRead || params.promptSurface === "cli_backend";
  const installedSkillSearch = availableTools.has("skills_search");
  // Code Mode searches the admitted skill catalog; listing it again only consumes context.
  const skillsPrompt =
    canAccess && !(params.codeModeActive && installedSkillSearch)
      ? (params.skillsPrompt?.trim() ?? "")
      : "";
  const hasListedSkills = parseSkillsPromptCatalog(skillsPrompt).length > 0;
  if (!canAccess || (!hasListedSkills && !installedSkillSearch)) {
    return { skillsPrompt, section: skillsPrompt ? ["## Skills", skillsPrompt, ""] : [] };
  }
  const renderedSkillsPrompt =
    installedSkillRead && hasListedSkills ? compactCatalogForSkillRead(skillsPrompt) : skillsPrompt;
  const dispatchDeferredSkills =
    !params.deferredToolsDirectlyCallable && visibleTools.has(TOOL_CALL_RAW_TOOL_NAME);
  const readCall =
    dispatchDeferredSkills && !visibleTools.has("skills_read")
      ? `call \`${TOOL_CALL_RAW_TOOL_NAME}\` with \`{"id":"skills_read","args":{"name":"<name>"}}\``
      : "use `skills_read` with its exact name";
  const searchCall = params.codeModeActive
    ? "with `skills.search(query)` inside `exec`"
    : dispatchDeferredSkills && !visibleTools.has("skills_search")
      ? `by calling \`${TOOL_CALL_RAW_TOOL_NAME}\` with \`{"id":"skills_search","args":{"query":"<query>"}}\``
      : "with `skills_search`";
  return {
    skillsPrompt: renderedSkillsPrompt,
    section: [
      "## Skills",
      ...(hasListedSkills
        ? [
            params.codeModeActive && installedSkillRead
              ? 'Scan `<available_skills>` for a matching workflow; load a known name or clear match with `skills.read("<name>")` inside `exec` before acting.'
              : installedSkillRead
                ? `Scan \`<available_skills>\` for a matching workflow; load a known name or clear match by ${readCall} before acting.`
                : `Scan \`<available_skills>\` for a matching workflow; read exact \`<location>\` with \`${params.readToolName}\` before acting.`,
          ]
        : [
            params.codeModeActive && installedSkillRead
              ? 'No skills listed here; load a known skill with `skills.read("<name>")` inside `exec`.'
              : installedSkillRead
                ? `No skills listed here; load a known skill by ${readCall}.`
                : "No skills listed here.",
          ]),
      ...(installedSkillSearch
        ? [
            `For specialized, unfamiliar, or reusable workflows, ${hasListedSkills ? "use a listed match or search" : "search"} ${searchCall} (by goal/terms; skip for simple local file work or self-contained answers; searches installed skills only).`,
          ]
        : []),
      "Pick at most one (most specific) up front; read none if irrelevant; never invent paths. Batch external writes safely and honor 429/Retry-After.",
      ...(renderedSkillsPrompt ? [renderedSkillsPrompt] : []),
      "",
    ],
  };
}
