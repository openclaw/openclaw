import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import { parseSkillsPromptCatalog } from "../skills/loading/skill-prompt-catalog.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "./tool-catalog.js";

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
    skillsPrompt,
    section: [
      "## Skills",
      ...(hasListedSkills
        ? ["Scan <available_skills> for a matching workflow."]
        : ["No skill entries are listed in this prompt."]),
      params.codeModeActive && installedSkillRead
        ? 'Known name or clear match: use `skills.read("<name>")` inside `exec`; read the complete instructions before task actions and follow them.'
        : installedSkillRead
          ? `Known name or clear match: ${readCall}; read the complete instructions before task actions and follow them.`
          : `Clear match: read exact <location> with \`${params.readToolName}\`; obey.`,
      ...(installedSkillSearch
        ? [
            `Before work involving files, specialized tools, or a reusable workflow, ${hasListedSkills ? "use a listed match or search" : "search"} ${searchCall} for an applicable skill. Read the best match before implementing the workflow yourself.`,
            "Search by the task goal and distinctive terms. Simple conversation or a self-contained answer does not need a search. Search covers installed skills; it does not install skills.",
          ]
        : []),
      "Several: most specific. No relevant skill: read none.",
      "Up-front max one. Never invent paths.",
      "External writes: batch safely; no tight loops; honor 429/Retry-After.",
      ...(skillsPrompt ? [skillsPrompt] : []),
      "",
    ],
  };
}
