import YAML from "yaml";
import { ProjectFrontmatterSchema, QueueFrontmatterSchema } from "./schemas.js";

/**
 * Generate PROJECT.md content with valid YAML frontmatter and defaults
 * filled by the Zod schema (columns, dashboard widgets, status).
 */
export function generateProjectMd(opts: {
  name: string;
  description?: string;
  owner?: string;
}): string {
  const today = new Date().toISOString().split("T")[0];
  const data = ProjectFrontmatterSchema.parse({
    name: opts.name,
    description: opts.description,
    owner: opts.owner,
    created: today,
    updated: today,
  });

  const yaml = YAML.stringify(data, { schema: "core" });
  const desc = opts.description ?? "";
  return `---\n${yaml}---\n\n# ${opts.name}\n\n${desc}\n`;
}

/**
 * Generate queue.md content with frontmatter and four empty section headings:
 * Available, Claimed, Done, Blocked.
 */
export function generateQueueMd(): string {
  const today = new Date().toISOString().split("T")[0];
  const data = QueueFrontmatterSchema.parse({ updated: today });

  const yaml = YAML.stringify(data, { schema: "core" });
  return `---\n${yaml}---\n\n## Available\n\n## Claimed\n\n## Done\n\n## Blocked\n`;
}
