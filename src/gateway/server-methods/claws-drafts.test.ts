import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { validateClawDraftDocument } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clawDraftRevision,
  createClawDraft,
  MAX_CLAW_DRAFT_BYTES,
  prepareClawDraft,
} from "../../claws/draft.js";
import { extractBuiltClawArtifact } from "../../claws/project-build.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { clawsDraftsHandlers } from "./claws-drafts.js";
import type { GatewayClient } from "./client-types.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function requestDraft(
  operation: "create" | "save" | "review" | "publish",
  workspace: string,
  params: Record<string, unknown> = {},
  condition?: string,
  connections?: ReadonlySet<string>,
) {
  const method = `claws.drafts.${operation}`;
  const replies: Parameters<RespondFn>[] = [];
  // SAFETY: These are the live socket fields read by draft authority.
  const client = {
    connId: "draft-author",
    authenticatedUserProfile: {
      profileId: "creator",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { role: "operator", scopes: ["operator.admin"] },
    internal: { syntheticClient: condition === "synthetic", operatorRoleActor: { kind: "system" } },
  } as GatewayClient;
  await expectDefined(
    clawsDraftsHandlers[method],
    method,
  )({
    req: { type: "req", id: operation, method },
    params: { agentId: "research", ...params },
    client,
    context: createDirectChatContext({
      getRuntimeConfig: () => ({
        agents: { entries: { research: { workspace } } },
        gateway: { controlUi: { experimental: { claws: condition !== "labs-off" } } },
      }),
      getClientConnIds: () =>
        connections ?? new Set(condition === "disconnected" ? [] : ["draft-author"]),
    }),
    respond: (...args) => {
      replies.push(args);
    },
    isWebchatConnect: () => false,
  });
  expect(replies).toHaveLength(1);
  return replies[0]!;
}

describe("Claw draft human authority", () => {
  it("registers draft methods only for administrators", () => {
    for (const method of Object.keys(clawsDraftsHandlers)) {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(
        authorizeOperatorScopesForMethod(method, ["operator.read", "operator.write"]).allowed,
      ).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"]).allowed).toBe(true);
    }
  });

  it.each([256 * 1024 + 1, MAX_CLAW_DRAFT_BYTES])(
    "saves an existing %i-byte draft while retaining revision conflicts",
    async (size) => {
      const workspace = tempDirs.make("openclaw-large-claw-draft-");
      const draft = await createClawDraft(workspace);
      const document: unknown = JSON.parse(await readFile(draft.path, "utf8"));
      if (!validateClawDraftDocument(document)) {
        throw new Error("Expected a valid initial draft");
      }
      const file = { path: "notes.md", content: "" };
      document.files = [file];
      const overhead = Buffer.byteLength(JSON.stringify(document));
      file.content = "a".repeat(size - overhead);
      const original = JSON.stringify(document);
      const edited = original.replace('"my-claw"', '"my-edit"');
      await writeFile(draft.path, original);
      const save = (content: string) =>
        requestDraft("save", workspace, {
          draftId: draft.draftId,
          content,
          expectedRevision: clawDraftRevision(original),
        });
      expect(Buffer.byteLength(original)).toBe(size);
      const result = await save(edited);
      expect(result[0], JSON.stringify(result[2])).toBe(true);
      expect(result[1]).toMatchObject({ revision: clawDraftRevision(edited) });
      expect(await readFile(draft.path, "utf8")).toBe(edited);
      expect((await save(original))[0]).toBe(false);
      expect(await readFile(draft.path, "utf8")).toBe(edited);
    },
  );

  it.each(["synthetic", "disconnected", "labs-off"])(
    "refuses %s creation before touching the workspace",
    async (condition) => {
      const reply = await requestDraft("create", "/not-a-real-claw-draft-workspace", {}, condition);
      expect(reply[0]).toBe(false);
      expect(reply[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );
});

async function reviewDraft(
  workspace: string,
  params: Record<string, unknown>,
  connections?: ReadonlySet<string>,
) {
  const result = await requestDraft("review", workspace, params, undefined, connections);
  expect(result[0], JSON.stringify(result[2])).toBe(true);
  const payload = result[1];
  if (
    !isRecord(payload) ||
    typeof payload.reviewToken !== "string" ||
    typeof payload.name !== "string" ||
    !Array.isArray(payload.files)
  ) {
    throw new Error("Expected the public Claw draft review response");
  }
  const files = payload.files.map((file: unknown) => {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("Expected reviewed archive file contents");
    }
    return { path: file.path, content: file.content };
  });
  return { reviewToken: payload.reviewToken, name: payload.name, files };
}

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

describe("Claw draft reviewed publication", () => {
  beforeEach(() => {
    vi.stubEnv("CLAWHUB_TOKEN", "fixture-personal-token");
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://registry.example.test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("removes unchecked files and dependencies from the exact archive and binds the review token to the choices", async () => {
    const workspaceDir = tempDirs.make("claw-draft-selections-");
    const draft = await createClawDraft(workspaceDir);
    const manifest = {
      schemaVersion: 1,
      agent: { id: "research-brief", description: "Original agent description" },
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
        files: [{ source: "workspace/checklist.md", path: "checklist.md" }],
      },
      packages: [
        { kind: "skill", source: "clawhub", ref: "@maker/sources", version: "1.2.3" },
        { kind: "plugin", source: "clawhub", ref: "@maker/github", version: "2.0.0" },
      ],
      mcpServers: { research: { command: "research-mcp" } },
      cronJobs: [
        {
          id: "weekly-recap",
          schedule: { cron: "0 9 * * 1", timezone: "UTC" },
          session: "isolated",
          message: "Recap research.",
        },
      ],
    };
    await writeFile(
      draft.path,
      JSON.stringify({
        ...proposal,
        manifest: `---\n${stringify(manifest)}---\nResearch public sources.\n`,
        files: [
          { path: "workspace/AGENTS.md", content: "Keep citations." },
          { path: "workspace/checklist.md", content: "Check dates." },
        ],
      }),
    );
    const choices = {
      name: "public-researcher",
      description: "Researches public sources for a new user.",
      excluded: [
        "file:workspace/checklist.md",
        "package:skill:@maker/sources",
        "package:plugin:@maker/github",
        "mcp:research",
        "cron:weekly-recap",
      ],
    };
    await using selected = await prepareClawDraft({
      workspaceDir,
      draftId: draft.draftId,
      publisher: "maker",
      choices,
    });
    expect(selected.files.map((file) => file.path)).toEqual([
      "CLAW.md",
      "package.json",
      "workspace/AGENTS.md",
    ]);
    expect(selected.items.filter((item) => item.included).map((item) => item.id)).toEqual([
      "file:workspace/AGENTS.md",
    ]);
    const claw = selected.files.find((file) => file.path === "CLAW.md")!.content;
    expect(claw).toContain("description: Researches public sources for a new user.");
    expect(claw).not.toMatch(/checklist|@maker\/sources|@maker\/github|research-mcp|weekly-recap/);

    let posts = 0;
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
      }
      return Response.json({ user: { handle: "maker" } });
    });
    const review = await reviewDraft(workspaceDir, { draftId: draft.draftId, choices });
    const rejected = await requestDraft("publish", workspaceDir, {
      draftId: draft.draftId,
      choices: { ...choices, excluded: [] },
      reviewToken: review.reviewToken,
    });
    expect(rejected[0]).toBe(false);
    expect(rejected[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "The draft or publisher changed. Review the current files before publishing.",
    });
    expect(posts).toBe(0);
  });

  it("uploads exactly the reviewed archive under the personal publisher and reports scanning honestly", async () => {
    const workspaceDir = tempDirs.make("claw-draft-publish-");
    const draft = await createClawDraft(workspaceDir);
    await writeFile(draft.path, JSON.stringify(proposal));
    const uploads: Array<{ metadata: Record<string, unknown>; bytes: Buffer }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
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
    });
    const review = await reviewDraft(workspaceDir, { draftId: draft.draftId });
    expect(uploads).toHaveLength(0);
    const result = await requestDraft("publish", workspaceDir, {
      draftId: draft.draftId,
      reviewToken: review.reviewToken,
    });
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({
      name: review.name,
      url: "https://registry.example.test/maker/claws/research-brief",
      publicationStatus: "pending",
    });
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
      let publisher = "maker";
      const connections = new Set(["draft-author"]);
      let revokeOnIdentity = false;
      let posts = 0;
      vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts += 1;
        }
        if (revokeOnIdentity) {
          connections.delete("draft-author");
        }
        return Response.json({ user: { handle: publisher } });
      });
      const review = await reviewDraft(workspaceDir, { draftId: draft.draftId }, connections);
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
      const result = await requestDraft(
        "publish",
        workspaceDir,
        { draftId: draft.draftId, reviewToken: review.reviewToken },
        undefined,
        connections,
      );
      expect(result[0]).toBe(false);
      expect(result[2]).toMatchObject(
        change === "authority"
          ? {
              code: "FORBIDDEN",
              message:
                "Create, review, and publish Claws from an active administrator Control UI connection.",
            }
          : {
              code: "INVALID_REQUEST",
              message:
                "The draft or publisher changed. Review the current files before publishing.",
            },
      );
      expect(posts).toBe(0);
    },
  );
});
