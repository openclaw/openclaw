import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillLibraryEntry,
  SkillLibraryFile,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import {
  createCatalogCodeModeHarness,
  resetCodeModeTestState,
  resultText,
} from "../code-mode.test-support.js";
import { createLibrarySkillWorkshopTool } from "./skill-workshop-tool-library.js";

const entry: SkillLibraryEntry = {
  skillId: "00000000-0000-4000-8000-000000000001",
  slug: "release-guide",
  name: "s_release_guide",
  description: "A synthetic personal skill",
  ownerProfileId: "owner",
  ownerLabel: "Owner label not needed by the tool",
  authorProfileId: "author",
  shared: false,
  enabled: true,
  removed: false,
  revision: "a".repeat(64),
  createdAt: 1,
  updatedAt: 1,
  canEdit: true,
};
const content = "# Release guide\nCheck the release candidate before publishing.\n";
const privateBytes = "UNSELECTED_SUPPORT_BYTES";
const file = (name: string, bytes = privateBytes): SkillLibraryFile => ({
  path: `references/${name}.txt`,
  content: bytes,
});
const readResult = (files: SkillLibraryFile[]) => ({ entry, content, files, revisions: [] });

function libraryTool(invoke: SkillLibraryAuthoringCapability["invoke"]) {
  return createLibrarySkillWorkshopTool({
    target: "personal",
    defaultTarget: "personal",
    multipleProfiles: true,
    bind: vi.fn(),
    invoke,
  });
}

afterEach(resetCodeModeTestState);

describe("personal Skill Workshop results", () => {
  it("lets Code Mode discover a personal skill and read its whole guidance", async () => {
    const entries = Array.from({ length: 21 }, (_, index) => ({
      ...entry,
      skillId: index === 0 ? entry.skillId : String(index),
    }));
    const tool = libraryTool(async ({ action, skillId }) => {
      if (action === "list") {
        return {
          entries,
          profileId: "owner",
          multipleProfiles: true,
          defaultTarget: "personal",
          canManageWorkspace: false,
          defaultSelectionLimit: 20,
        };
      }
      expect(skillId).toBe(entry.skillId);
      return readResult([file("private")]);
    });
    const h = createCatalogCodeModeHarness([tool]);
    const result = await h.complete(`
        const [workshop] = await catalog.search("skill_workshop");
        const listed = await workshop({ action: "list", target: "personal" });
        return { listed, read: await workshop({
          action: "read", target: "personal", skill_id: listed.entries[0].skillId
        }) };
      `);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.value).toMatchObject({
      listed: {
        entries: entries
          .slice(0, 20)
          .map(({ skillId }) => ({ skillId, slug: "release-guide", canEdit: true })),
        omitted: 1,
      },
      read: {
        skillId: entry.skillId,
        revision: entry.revision,
        artifactPath: "SKILL.md",
        content,
        contentIncluded: true,
        supportFiles: [{ path: "references/private.txt", executable: false }],
        omittedFiles: 0,
      },
    });
    expect(JSON.stringify(result.value)).not.toContain(privateBytes);
    expect(JSON.stringify(result.value)).not.toContain(entry.ownerLabel);
    expect(result.value).not.toHaveProperty("listed.profileId");
  });

  it.each([
    [Buffer.from("x".repeat(16000)), true, undefined],
    [Buffer.from("x".repeat(16001)), false, "too-large"],
    [Buffer.from([0, 255, 128]), false, "binary"],
  ] as const)(
    "bounds whole artifacts in both result surfaces (%#)",
    async (bytes, included, reason) => {
      const selected: SkillLibraryFile = {
        ...file("selected", bytes.toString("base64")),
        encoding: "base64",
        executable: true,
      };
      const files = [selected, ...Array.from({ length: 32 }, (_, index) => file(`other-${index}`))];
      const tool = libraryTool(async () => readResult(files));
      const result = await tool.execute("read", {
        action: "read",
        skill_id: entry.skillId,
        artifact_path: selected.path,
      });
      expect(result.details).toMatchObject({
        artifactPath: selected.path,
        contentIncluded: included,
        ...(included ? { content: bytes.toString("utf8") } : { omissionReason: reason }),
        supportFiles: expect.arrayContaining([{ path: selected.path, executable: true }]),
        omittedFiles: 1,
      });
      expect(result.details).toHaveProperty("supportFiles.length", 32);
      expect(JSON.parse(resultText(result))).toEqual(result.details);
      expect(JSON.stringify(result)).not.toContain(privateBytes);
      if (!included) {
        expect(result.details).not.toHaveProperty("content", expect.any(String));
        expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
      }
    },
  );
});
