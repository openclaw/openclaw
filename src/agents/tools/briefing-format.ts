type SectionData = { title: string; error?: string; [key: string]: unknown };

export function formatMorningBriefing(sections: SectionData[]): string {
  const parts = ["# Morning Briefing"];
  for (const section of sections) {
    if (section.error) {
      parts.push(section.error);
    } else {
      parts.push(`## ${section.title}\n${JSON.stringify(section, null, 2)}`);
    }
  }
  return parts.join("\n\n");
}

export function formatWeeklyRecap(sections: SectionData[]): string {
  const parts = ["# Weekly Recap"];
  for (const section of sections) {
    if (section.error) {
      parts.push(section.error);
    } else {
      parts.push(`## ${section.title}\n${JSON.stringify(section, null, 2)}`);
    }
  }
  return parts.join("\n\n");
}

export function formatSectionError(name: string, _error?: unknown): string {
  return `## ${name}\n[Unable to fetch ${name.toLowerCase()} data]`;
}
