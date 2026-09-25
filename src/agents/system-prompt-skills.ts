export function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
  codeModeActive?: boolean;
  installedSkillSearch?: boolean;
  installedSkillRead?: boolean;
}) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed && !params.installedSkillSearch) {
    return [];
  }
  return [
    "## Skills",
    params.codeModeActive && params.installedSkillRead
      ? 'Scan <available_skills>. Clear match: use `skills.read("<name>")` inside `exec`; obey.'
      : params.installedSkillRead
        ? "Scan <available_skills>. Clear match: use `skills_read` with its exact name; obey."
        : `Scan <available_skills>. Clear match: read exact <location> with \`${params.readToolName}\`; obey.`,
    ...(params.installedSkillSearch
      ? [
          params.codeModeActive
            ? "The directory is bounded. For missing task guidance, use `skills.search(query)` inside `exec`. Search covers installed skills; it does not install skills."
            : "The directory is bounded. For missing task guidance, use `skills_search`. Search covers installed skills; it does not install skills.",
        ]
      : []),
    "Several: most specific. No relevant skill: read none.",
    "Up-front max one. Never invent paths.",
    "External writes: batch safely; no tight loops; honor 429/Retry-After.",
    ...(trimmed ? [trimmed] : []),
    "",
  ];
}
