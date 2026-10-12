import { parseSkillsPromptCatalog } from "../skills/loading/skill-prompt-catalog.js";

export function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
  codeModeActive?: boolean;
  installedSkillSearch?: boolean;
  installedSkillRead?: boolean;
  installedSkills?: readonly { name: string; description: string }[];
  compactSkills?: boolean;
}) {
  const trimmed = params.skillsPrompt?.trim();
  if (params.compactSkills !== false && params.installedSkillSearch && params.installedSkillRead) {
    const skills = params.installedSkills ?? parseSkillsPromptCatalog(trimmed ?? "", true);
    const ordered = skills.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const search = params.codeModeActive
      ? "`skills.search(query)` inside `exec`"
      : "`skills_search`";
    const read = params.codeModeActive
      ? '`skills.read("<name>")` inside `exec`'
      : "`skills_read` with its exact name";
    let catalog = ordered
      .map(({ name, description }) => {
        const trigger = (description ?? "").replace(/\s+/gu, " ").trim().slice(0, 60);
        return trigger ? `- ${name}: ${trigger}` : `- ${name}`;
      })
      .join("\n");
    if (catalog.length > 4000) {
      catalog = ordered.map(({ name }) => `- ${name}`).join("\n");
    }
    if (catalog.length > 4000) {
      catalog = `${skills.length} skills installed; use ${search}.`;
    }
    return [
      "## Skills",
      "Use a skill when the task matches its trigger or the user names it.",
      "Check listed skills once when a new task starts. Search or read again only when scope changes or the user names a skill.",
      `Search with ${search} when the task likely needs a reusable workflow you don't see listed.`,
      `Read the matching skill's complete instructions with ${read} before task actions and follow them.`,
      "Relative helper/reference paths: search the exact skill name for its location, then resolve them from the skill directory, not the workspace.",
      "Several: most specific. No relevant skill: read none. Up-front max one.",
      "Search covers installed skills; it does not install skills.",
      "External writes: batch safely; no tight loops; honor 429/Retry-After.",
      catalog,
      "",
    ];
  }
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
          `When the task likely needs a reusable workflow you don't see listed, search with ${params.codeModeActive ? "`skills.search(query)` inside `exec`" : "`skills_search`"} for an applicable skill. Use a skill when the task matches its trigger or the user names it.`,
          "Search by the task goal and distinctive terms. Simple conversation or a self-contained answer does not need a search. Search covers installed skills; it does not install skills.",
        ]
      : []),
    "Several: most specific. No relevant skill: read none.",
    "Up-front max one. Never invent paths.",
    "External writes: batch safely; no tight loops; honor 429/Retry-After.",
    ...(trimmed ? [trimmed] : []),
    "",
  ];
}
