import { parseSkillsPromptCatalog } from "../skills/loading/skill-prompt-catalog.js";

export function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
  codeModeActive?: boolean;
  installedSkillSearch?: boolean;
  installedSkillRead?: boolean;
}) {
  const trimmed = params.skillsPrompt?.trim();
  const hasListedSkills = parseSkillsPromptCatalog(trimmed ?? "").length > 0;
  if (!hasListedSkills && !params.installedSkillSearch) {
    return trimmed ? ["## Skills", trimmed, ""] : [];
  }
  return [
    "## Skills",
    ...(hasListedSkills
      ? ["Scan <available_skills> for a matching workflow."]
      : ["No skill entries are listed in this prompt."]),
    params.codeModeActive && params.installedSkillRead
      ? 'Known name or clear match: use `skills.read("<name>")` inside `exec`; read the complete instructions before task actions and follow them.'
      : params.installedSkillRead
        ? "Known name or clear match: use `skills_read` with its exact name; read the complete instructions before task actions and follow them."
        : `Clear match: read exact <location> with \`${params.readToolName}\`; obey.`,
    ...(params.installedSkillSearch
      ? [
          `Before work involving files, specialized tools, or a reusable workflow, ${hasListedSkills ? "use a listed match or search" : "search"} with ${params.codeModeActive ? "`skills.search(query)` inside `exec`" : "`skills_search`"} for an applicable skill. Read the best match before implementing the workflow yourself.`,
          "Search by the task goal and distinctive terms. Simple conversation or a self-contained answer does not need a search. Search covers installed skills; it does not install skills.",
        ]
      : []),
    "Several: most specific. No relevant skill: read none.",
    "Up-front max one; read another applicable skill when the active workflow requires it. Never invent paths.",
    "External writes: batch safely; no tight loops; honor 429/Retry-After.",
    ...(trimmed ? [trimmed] : []),
    "",
  ];
}
