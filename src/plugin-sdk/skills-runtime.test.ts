import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  Skill,
  SkillEntry,
} from "./skills-runtime.js";
import {
  loadVisibleWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillKey,
} from "./skills-runtime.js";

describe("plugin SDK skills runtime exports", () => {
  it("re-exports workspace skill loaders", () => {
    expect(typeof loadWorkspaceSkillEntries).toBe("function");
    expect(typeof loadVisibleWorkspaceSkillEntries).toBe("function");
  });

  it("re-exports skill frontmatter helpers", () => {
    const frontmatter = parseFrontmatter(
      `---\nname: Demo\nmetadata: '{"openclaw":{"skillKey":"demo-key"}}'\n---\n`,
    );

    expect(frontmatter.name).toBe("Demo");
    expect(resolveOpenClawMetadata(frontmatter)?.skillKey).toBe("demo-key");
    expect(
      resolveSkillKey(
        { name: "fallback" } as Skill,
        { metadata: { skillKey: "demo" } } as SkillEntry,
      ),
    ).toBe("demo");
  });

  it("exposes the public skill runtime types", () => {
    expectTypeOf<ParsedSkillFrontmatter>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<SkillEntry["metadata"]>().toEqualTypeOf<OpenClawSkillMetadata | undefined>();
  });
});
