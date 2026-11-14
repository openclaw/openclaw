import { describe, expect, it } from "vitest";
import { materializeSkill } from "./skill-materializer.js";

function materialize(
  content: string,
  name = "sample-skill",
  frontmatter: Record<string, string> = {},
) {
  return materializeSkill({
    content,
    frontmatter,
    name,
    description: "Sample skill used by the display-name tests.",
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source: "workspace",
    sourceOptions: { source: "workspace", scope: "project", origin: "top-level" },
  });
}

describe("materializeSkill display name", () => {
  it("ignores a later heading that belongs to embedded shared boilerplate", () => {
    const skill = materialize(
      [
        "---",
        "name: obsidian-save",
        "description: Save notes.",
        "---",
        "",
        "## Setup (read first)",
        "",
        "Resolve the vault root before writing.",
        "",
        "---",
        "",
        "## AI-first vault rule (embedded)",
        "",
        "# AI-First Note Rules",
        "",
        "Shared boilerplate body.",
        "",
      ].join("\n"),
      "obsidian-save",
      { name: "obsidian-save" },
    );

    expect(skill.displayName).toBe("Obsidian Save");
  });

  it("keeps a heading that opens the body as the display title", () => {
    const skill = materialize(
      "---\nname: long-desc\ndescription: Titled by its body.\n---\n# Short Description\n",
      "long-desc",
      { name: "long-desc" },
    );

    expect(skill.displayName).toBe("Short Description");
  });

  it("accepts a title heading after leading blank lines", () => {
    const skill = materialize(
      "---\nname: long-desc\ndescription: Titled by its body.\n---\n\n# Short Description\n",
      "long-desc",
      { name: "long-desc" },
    );

    expect(skill.displayName).toBe("Short Description");
  });

  it("does not treat an indented code block as a heading", () => {
    const skill = materialize("\n    # Install prerequisites\n    npm install\n", "guide");

    expect(skill.displayName).toBe("Guide");
  });

  it("falls back to the humanized frontmatter name without a body heading", () => {
    const skill = materialize(
      "---\nname: guide\ndescription: No heading here.\n---\nPlain body prose only.\n",
      "guide",
      { name: "guide" },
    );

    expect(skill.displayName).toBe("Guide");
  });
});
