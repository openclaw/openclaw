import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createClawDraft, prepareClawDraft } from "./draft.js";
import { extractBuiltClawArtifact } from "./project-build.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const proposal = {
  name: "research-brief",
  version: "0.1.0",
  scope: {
    input: "A research question and public sources.",
    job: "Compare sources and produce a cited brief.",
    output: "A short Markdown brief with links and uncertainties.",
    authority: "Read public sources. Ask before sending messages or spending money.",
  },
  manifest:
    "---\nschemaVersion: 1\nagent:\n  id: research-brief\n---\nCompare primary sources and cite every factual claim.\n",
  files: [],
};

describe("agent-created Claw drafts", () => {
  it("keeps the package slug while showing a title-cased agent name", async () => {
    const workspaceDir = tempDirs.make("claw-draft-display-name-");
    const draft = await createClawDraft(workspaceDir);
    await writeFile(draft.path, JSON.stringify(proposal));
    const target = { workspaceDir, draftId: draft.draftId };

    await using initial = await prepareClawDraft({ ...target, publisher: "maker" });
    expect(initial.displayName).toBe("Research Brief");

    const choices = {
      name: "research-brief",
      displayName: "Engineering Partner",
      description: "A collaborative engineering partner.",
      excluded: [],
    };
    await using prepared = await prepareClawDraft({
      ...target,
      publisher: "maker",
      choices,
    });
    expect(prepared.name).toBe("@maker/research-brief");
    expect(prepared.displayName).toBe("Engineering Partner");
    expect(prepared.files.find((file) => file.path === "CLAW.md")?.content).toContain(
      "id: research-brief\n  name: Engineering Partner",
    );
  });

  it("builds only the reviewed proposal, excluding the source workspace and private draft metadata", async () => {
    const workspaceDir = tempDirs.make("claw-draft-privacy-");
    await writeFile(join(workspaceDir, "MEMORY.md"), "PRIVATE_MEMORY_SENTINEL");
    await writeFile(join(workspaceDir, "USER.md"), "PRIVATE_PERSON_SENTINEL");
    await writeFile(join(workspaceDir, ".env"), "PRIVATE_CREDENTIAL_SENTINEL");
    const draft = await createClawDraft(workspaceDir);
    expect(await readFile(draft.path, "utf8")).toContain('"name": "my-claw"');
    await expect(
      readFile(join(workspaceDir, ".openclaw/claw-drafts/current.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(draft.path, JSON.stringify(proposal));

    await using prepared = await prepareClawDraft({
      workspaceDir,
      draftId: draft.draftId,
      publisher: "maker",
    });
    expect(prepared.name).toBe("@maker/research-brief");
    expect(prepared.files.map((file) => file.path).toSorted()).toEqual(["CLAW.md", "package.json"]);
    await using extracted = await extractBuiltClawArtifact(prepared.artifact);
    const manifest = await readFile(join(extracted.packageRoot, "CLAW.md"), "utf8");
    expect(manifest).toContain(proposal.scope.authority);
    expect(manifest).not.toMatch(/PRIVATE_|claw-drafts/);
    expect(JSON.parse(await readFile(join(extracted.packageRoot, "package.json"), "utf8"))).toEqual(
      {
        name: "@maker/research-brief",
        version: "0.1.0",
        openclaw: { claw: "CLAW.md" },
      },
    );
  });

  it("keeps overlapping drafts in distinct request-specific files", async () => {
    const workspaceDir = tempDirs.make("claw-draft-overlap-");
    const [first, second] = await Promise.all([
      createClawDraft(workspaceDir),
      createClawDraft(workspaceDir),
    ]);

    expect(first.draftId).not.toBe(second.draftId);
    await writeFile(first.path, JSON.stringify({ ...proposal, name: "first-claw" }));
    await writeFile(second.path, JSON.stringify({ ...proposal, name: "second-claw" }));
    await expect(readFile(first.path, "utf8")).resolves.toContain('"name":"first-claw"');
    await expect(readFile(second.path, "utf8")).resolves.toContain('"name":"second-claw"');
    await expect(
      readFile(join(workspaceDir, ".openclaw/claw-drafts/current.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
    const workspaceDir = tempDirs.make("claw-draft-private-");
    const draft = await createClawDraft(workspaceDir);
    await writeFile(
      draft.path,
      JSON.stringify({ ...proposal, files: [{ path, content: "private context" }] }),
    );
    await expect(
      prepareClawDraft({ workspaceDir, draftId: draft.draftId, publisher: "maker" }),
    ).rejects.toMatchObject({ code: "private_draft_file" });
  });

  it("refuses credential-like text without reflecting the credential in the error", async () => {
    const workspaceDir = tempDirs.make("claw-draft-secret-");
    const draft = await createClawDraft(workspaceDir);
    const secret = `ghp_${"x".repeat(36)}`;
    await writeFile(
      draft.path,
      JSON.stringify({ ...proposal, manifest: `${proposal.manifest}\n${secret}` }),
    );
    await expect(
      prepareClawDraft({ workspaceDir, draftId: draft.draftId, publisher: "maker" }),
    ).rejects.toMatchObject({
      code: "sensitive_draft_content",
      message: expect.not.stringContaining(secret),
    });
  });

  it("rejects a draft file replaced by a symlink to source material", async () => {
    const workspaceDir = tempDirs.make("claw-draft-symlink-");
    const draft = await createClawDraft(workspaceDir);
    const privatePath = join(workspaceDir, "private.json");
    await writeFile(privatePath, JSON.stringify(proposal));
    await unlink(draft.path);
    await symlink(privatePath, draft.path);
    await expect(
      prepareClawDraft({ workspaceDir, draftId: draft.draftId, publisher: "maker" }),
    ).rejects.toThrow();
  });
});
