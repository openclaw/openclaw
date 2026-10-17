import { createHash } from "node:crypto";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { publishClawDraft, reviewClawDraft } from "./draft-publish.js";
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
  it("builds only the reviewed proposal, excluding the source workspace and private draft metadata", async () => {
    const workspaceDir = tempDirs.make("claw-draft-privacy-");
    await writeFile(join(workspaceDir, "MEMORY.md"), "PRIVATE_MEMORY_SENTINEL");
    await writeFile(join(workspaceDir, "USER.md"), "PRIVATE_PERSON_SENTINEL");
    await writeFile(join(workspaceDir, ".env"), "PRIVATE_CREDENTIAL_SENTINEL");
    const draft = await createClawDraft(workspaceDir);
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

  it("uploads exactly the reviewed archive under the personal publisher and reports scanning honestly", async () => {
    const workspaceDir = tempDirs.make("claw-draft-publish-");
    const draft = await createClawDraft(workspaceDir);
    await writeFile(draft.path, JSON.stringify(proposal));
    const target = { workspaceDir, draftId: draft.draftId };
    const uploads: Array<{ metadata: Record<string, unknown>; bytes: Buffer }> = [];
    const options = {
      baseUrl: "https://registry.example.test",
      token: "fixture-personal-token",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.headers.get("Authorization")).toBe("Bearer fixture-personal-token");
        if (request.url.endsWith("/whoami")) {
          return Response.json({ user: { handle: "maker" } });
        }
        expect(request.method).toBe("POST");
        const form = await request.formData();
        const payload = form.get("payload");
        const archive = form.get("clawpack");
        if (typeof payload !== "string" || !(archive instanceof File)) {
          throw new Error("Expected the real ClawHub multipart publication contract");
        }
        const bytes = Buffer.from(await archive.arrayBuffer());
        const metadata: Record<string, unknown> = JSON.parse(payload);
        expect(metadata).toMatchObject({
          name: "@maker/research-brief",
          family: "claw",
          channel: "community",
          ownerHandle: "maker",
          expectedArtifactSha256: createHash("sha256").update(bytes).digest("hex"),
        });
        uploads.push({ metadata, bytes });
        return Response.json({
          ok: true,
          artifactSha256: metadata.expectedArtifactSha256,
          publicationStatus: "pending",
        });
      },
    };
    const review = await reviewClawDraft(target, options);
    expect(uploads).toHaveLength(0);
    const result = await publishClawDraft(
      { ...target, reviewToken: review.reviewToken },
      () => {},
      options,
    );
    expect(result).toMatchObject({ name: review.name, publicationStatus: "pending" });
    expect(uploads).toHaveLength(1);
    const artifact = join(workspaceDir, "published.tgz");
    await writeFile(artifact, uploads[0]!.bytes);
    await using extracted = await extractBuiltClawArtifact(artifact);
    for (const file of review.files) {
      expect(await readFile(join(extracted.packageRoot, file.path), "utf8")).toBe(file.content);
    }
  });

  it.each(["draft", "publisher", "authority"])(
    "blocks publication when %s changes after review",
    async (change) => {
      const workspaceDir = tempDirs.make("claw-draft-stale-");
      const draft = await createClawDraft(workspaceDir);
      await writeFile(draft.path, JSON.stringify(proposal));
      const target = { workspaceDir, draftId: draft.draftId };
      let publisher = "maker";
      let current = true;
      let revokeOnIdentity = false;
      let posts = 0;
      const options = {
        token: "fixture-personal-token",
        fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST") {
            posts += 1;
          }
          if (revokeOnIdentity) {
            current = false;
          }
          return Response.json({ user: { handle: publisher } });
        },
      };
      const review = await reviewClawDraft(target, options);
      if (change === "draft") {
        await writeFile(
          draft.path,
          JSON.stringify({
            ...proposal,
            scope: { ...proposal.scope, authority: "Changed authority" },
          }),
        );
      }
      if (change === "publisher") {
        publisher = "another-person";
      }
      if (change === "authority") {
        revokeOnIdentity = true;
      }
      await expect(
        publishClawDraft(
          { ...target, reviewToken: review.reviewToken },
          () => {
            if (!current) {
              throw new Error("Source disconnected");
            }
          },
          options,
        ),
      ).rejects.toThrow();
      expect(posts).toBe(0);
    },
  );
});
