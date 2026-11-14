import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTemplateDraft, prepareTemplateDraft } from "./draft.js";
import { createResearchBriefProposal } from "./draft.test-support.js";
import { extractBuiltTemplateArtifact } from "./project-build.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const proposal = createResearchBriefProposal();

async function draftFixture(value: unknown = proposal) {
  const workspaceDir = tempDirs.make("template-draft-");
  const draft = await createTemplateDraft(workspaceDir);
  await writeFile(draft.path, JSON.stringify(value));
  const target = { workspaceDir, draftId: draft.draftId, publisher: "maker" };
  return { ...draft, workspaceDir, target, prepare: () => prepareTemplateDraft(target) };
}
const expectNoSharedDraft = (workspaceDir: string) =>
  expect(
    readFile(join(workspaceDir, ".openclaw/template-drafts/current.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });

describe("agent-created Template drafts", () => {
  it("keeps the package slug while showing a title-cased agent name", async () => {
    const { target, prepare } = await draftFixture();
    await using initial = await prepare();
    expect(initial.displayName).toBe("Research Brief");

    const choices = {
      name: "research-brief",
      displayName: "Engineering Partner",
      description: "A collaborative engineering partner.",
      excluded: [],
    };
    await using prepared = await prepareTemplateDraft({ ...target, choices });
    expect(prepared).toMatchObject({
      name: "@maker/research-brief",
      displayName: "Engineering Partner",
    });
    expect(prepared.files.find((file) => file.path === "CLAW.md")?.content).toContain(
      "id: research-brief\n  name: Engineering Partner",
    );
  });

  it("builds only the reviewed proposal, excluding the source workspace and private draft metadata", async () => {
    const workspaceDir = tempDirs.make("template-draft-privacy-");
    await writeFile(join(workspaceDir, "MEMORY.md"), "PRIVATE_MEMORY_SENTINEL");
    await writeFile(join(workspaceDir, "USER.md"), "PRIVATE_PERSON_SENTINEL");
    await writeFile(join(workspaceDir, ".env"), "PRIVATE_CREDENTIAL_SENTINEL");
    const draft = await createTemplateDraft(workspaceDir);
    expect(await readFile(draft.path, "utf8")).toContain('"name": "my-template"');
    await expectNoSharedDraft(workspaceDir);
    await writeFile(draft.path, JSON.stringify(proposal));

    await using prepared = await prepareTemplateDraft({
      workspaceDir,
      draftId: draft.draftId,
      publisher: "maker",
    });
    expect(prepared.name).toBe("@maker/research-brief");
    expect(prepared.files.map((file) => file.path).toSorted()).toEqual(["CLAW.md", "package.json"]);
    await using extracted = await extractBuiltTemplateArtifact(prepared.artifact);
    const manifest = await readFile(join(extracted.packageRoot, "CLAW.md"), "utf8");
    expect(manifest).toContain(proposal.scope.authority);
    expect(manifest).not.toMatch(/PRIVATE_|template-drafts/);
    expect(JSON.parse(await readFile(join(extracted.packageRoot, "package.json"), "utf8"))).toEqual(
      {
        name: "@maker/research-brief",
        version: "0.1.0",
        openclaw: { template: "CLAW.md" },
      },
    );
  });

  it("keeps overlapping drafts in distinct request-specific files", async () => {
    const workspaceDir = tempDirs.make("template-draft-overlap-");
    const [first, second] = await Promise.all([
      createTemplateDraft(workspaceDir),
      createTemplateDraft(workspaceDir),
    ]);

    expect(first.draftId).not.toBe(second.draftId);
    await writeFile(first.path, JSON.stringify({ ...proposal, name: "first-template" }));
    await writeFile(second.path, JSON.stringify({ ...proposal, name: "second-template" }));
    await expect(readFile(first.path, "utf8")).resolves.toContain('"name":"first-template"');
    await expect(readFile(second.path, "utf8")).resolves.toContain('"name":"second-template"');
    await expectNoSharedDraft(workspaceDir);
  });

  it.each([
    "MEMORY.md",
    "memory/notes.md",
    "USER.md",
    ".env",
    "sessions/log.jsonl",
    "history.JSONL",
    "../escape.md",
  ])("refuses private or escaping proposal files: %s", async (path) => {
    const { prepare } = await draftFixture({
      ...proposal,
      files: [{ path, content: "private context" }],
    });
    await expect(prepare()).rejects.toMatchObject({ code: "private_draft_file" });
  });

  it("refuses credential-like text without reflecting the credential in the error", async () => {
    const secret = `ghp_${"x".repeat(36)}`;
    const { prepare } = await draftFixture({
      ...proposal,
      manifest: `${proposal.manifest}\n${secret}`,
    });
    await expect(prepare()).rejects.toMatchObject({
      code: "sensitive_draft_content",
      message: expect.not.stringContaining(secret),
    });
  });

  it("rejects a draft file replaced by a symlink to source material", async () => {
    const { workspaceDir, path, prepare } = await draftFixture();
    const privatePath = join(workspaceDir, "private.json");
    await writeFile(privatePath, JSON.stringify(proposal));
    await unlink(path);
    await symlink(privatePath, path);
    await expect(prepare()).rejects.toThrow();
  });
});
