import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillLibraryEntry } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
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
      return {
        entry,
        content,
        files: [{ path: "references/private.txt", content: "UNSELECTED_SUPPORT_BYTES" }],
        revisions: [{ revision: entry.revision, createdAt: 1 }],
      };
    });
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });

    const result = await runUntilCompleted({
      execTool: expectDefined(h.tools[0], "exec"),
      waitTool: expectDefined(h.tools[1], "wait"),
      code: `
        const [workshop] = await catalog.search("skill_workshop");
        const listed = await workshop({ action: "list", target: "personal" });
        const read = await workshop({
          action: "read", target: "personal", skill_id: listed.entries[0].skillId
        });
        return { listed, read };
      `,
    });

    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.value).toMatchObject({
      listed: {
        entries: entries.slice(0, 20).map(({ skillId }) => ({
          skillId,
          slug: "release-guide",
          canEdit: true,
        })),
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
    expect(JSON.stringify(result.value)).not.toContain("UNSELECTED_SUPPORT_BYTES");
    expect(JSON.stringify(result.value)).not.toContain(entry.ownerLabel);
    expect(result.value).not.toHaveProperty("listed.profileId");
  });

  it.each([
    { name: "text at the limit", bytes: Buffer.from("x".repeat(16000)), included: true },
    {
      name: "oversized text",
      bytes: Buffer.from("x".repeat(16001)),
      included: false,
      reason: "too-large",
    },
    { name: "binary", bytes: Buffer.from([0, 255, 128]), included: false, reason: "binary" },
  ])(
    "preserves whole-artifact limits for $name in both result surfaces",
    async ({ bytes, included, reason }) => {
      const tool = libraryTool(async () => ({
        entry,
        content,
        files: [
          {
            path: "references/selected.txt",
            content: bytes.toString("base64"),
            encoding: "base64",
            executable: true,
          },
          ...Array.from({ length: 32 }, (_, index) => ({
            path: `references/other-${index}.txt`,
            content: "UNSELECTED_SUPPORT_BYTES",
          })),
        ],
        revisions: [],
      }));
      const result = await tool.execute("read", {
        action: "read",
        skill_id: entry.skillId,
        artifact_path: "references/selected.txt",
      });
      expect(result.details).toMatchObject({
        artifactPath: "references/selected.txt",
        contentIncluded: included,
        ...(included ? { content: bytes.toString("utf8") } : { omissionReason: reason }),
        supportFiles: expect.arrayContaining([
          { path: "references/selected.txt", executable: true },
        ]),
        omittedFiles: 1,
      });
      expect(result.details).toHaveProperty("supportFiles.length", 32);
      const text = result.content.find((block) => block.type === "text");
      expect(text?.type).toBe("text");
      expect(JSON.parse(text!.text)).toEqual(result.details);
      expect(JSON.stringify(result)).not.toContain("UNSELECTED_SUPPORT_BYTES");
      if (!included) {
        expect(result.details).not.toHaveProperty("content", expect.any(String));
        expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
      }
    },
  );
});
