import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateClawDraftDocument } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clawDraftRevision, createClawDraft, MAX_CLAW_DRAFT_BYTES } from "../../claws/draft.js";
import { createResearchBriefProposal } from "../../claws/draft.test-support.js";
import { extractBuiltClawArtifact } from "../../claws/project-build.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
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
    authenticatedUserProfile: gatewayProfile("creator"),
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

  it("saves a maximum-size draft while retaining revision conflicts", async () => {
    const size = MAX_CLAW_DRAFT_BYTES;
    const workspace = tempDirs.make("openclaw-large-claw-draft-");
    const draft = await createClawDraft(workspace);
    const document: unknown = JSON.parse(await readFile(draft.path, "utf8"));
    assert(validateClawDraftDocument(document));
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
  });

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
  assert(isRecord(payload));
  assert(typeof payload.reviewToken === "string" && typeof payload.name === "string");
  assert(Array.isArray(payload.files));
  const files = payload.files.map((file: unknown) => {
    assert(isRecord(file) && typeof file.path === "string" && typeof file.content === "string");
    return { path: file.path, content: file.content };
  });
  return { reviewToken: payload.reviewToken, name: payload.name, files, items: payload.items };
}

const proposal = createResearchBriefProposal();

async function publicationFixture(name = "@maker/research-brief") {
  const workspaceDir = tempDirs.make("claw-draft-publish-");
  const draft = await createClawDraft(workspaceDir);
  const connections = new Set(["draft-author"]);
  const uploads: Buffer[] = [];
  let posts = 0;
  const identity = { publisher: "maker", revoke: false };
  const write = (document = proposal) => writeFile(draft.path, JSON.stringify(document));
  await write();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      posts += 1;
    }
    expect(request.headers.get("Authorization")).toBe("Bearer fixture-personal-token");
    if (request.url.endsWith("/whoami")) {
      if (identity.revoke) {
        connections.delete("draft-author");
      }
      return Response.json({ user: { handle: identity.publisher } });
    }
    expect(request.method).toBe("POST");
    const form = await request.formData();
    const payload = form.get("payload");
    const archive = form.get("clawpack");
    assert(typeof payload === "string" && archive instanceof File);
    const bytes = Buffer.from(await archive.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(JSON.parse(payload)).toMatchObject({
      name,
      family: "claw",
      channel: "community",
      ownerHandle: "maker",
      expectedArtifactSha256: digest,
    });
    uploads.push(bytes);
    return Response.json({ ok: true, artifactSha256: digest, publicationStatus: "pending" });
  });
  return {
    workspaceDir,
    draft,
    uploads,
    get posts() {
      return posts;
    },
    identity,
    write,
    review: (params = {}) =>
      reviewDraft(workspaceDir, { draftId: draft.draftId, ...params }, connections),
    publish: (reviewToken: string, params = {}) =>
      requestDraft(
        "publish",
        workspaceDir,
        { draftId: draft.draftId, reviewToken, ...params },
        undefined,
        connections,
      ),
  };
}

describe("Claw draft reviewed publication", () => {
  beforeEach(() => {
    vi.stubEnv("CLAWHUB_TOKEN", "fixture-personal-token");
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://registry.example.test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("publishes exactly the reviewed selections under the personal publisher", async () => {
    const fixture = await publicationFixture("@maker/public-researcher");
    const { workspaceDir, draft, uploads } = fixture;
    await writeFile(
      draft.path,
      JSON.stringify({
        ...proposal,
        manifest: `---
schemaVersion: 1
agent: { id: research-brief, description: Original agent description }
workspace:
  bootstrapFiles: { AGENTS.md: { source: workspace/AGENTS.md } }
  files: [{ source: workspace/checklist.md, path: checklist.md }]
packages:
  - { kind: skill, source: clawhub, ref: "@maker/sources", version: 1.2.3 }
  - { kind: plugin, source: clawhub, ref: "@maker/github", version: 2.0.0 }
mcpServers: { research: { command: research-mcp } }
cronJobs:
  - id: weekly-recap
    schedule: { cron: "0 9 * * 1", timezone: UTC }
    session: isolated
    message: Recap research.
---
Research public sources.
`,
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
    const review = await fixture.review({ choices });
    expect(review.files.map((file) => file.path)).toEqual([
      "CLAW.md",
      "package.json",
      "workspace/AGENTS.md",
    ]);
    expect(review.items).toEqual([
      expect.objectContaining({ id: "file:workspace/AGENTS.md", included: true }),
      ...choices.excluded.map((id) => expect.objectContaining({ id, included: false })),
    ]);
    const claw = review.files.find((file) => file.path === "CLAW.md")!.content;
    expect(claw).toContain("description: Researches public sources for a new user.");
    expect(claw).not.toMatch(/checklist|@maker\/sources|@maker\/github|research-mcp|weekly-recap/);

    const rejected = await fixture.publish(review.reviewToken, {
      choices: { ...choices, excluded: [] },
    });
    expect(rejected[0]).toBe(false);
    expect(rejected[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "The draft or publisher changed. Review the current files before publishing.",
    });
    expect(fixture.posts).toBe(0);
    const result = await fixture.publish(review.reviewToken, { choices });
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({
      name: review.name,
      url: "https://registry.example.test/maker/claws/public-researcher",
      publicationStatus: "pending",
    });
    expect(uploads).toHaveLength(1);
    const artifact = join(workspaceDir, "published.tgz");
    await writeFile(artifact, uploads[0]!);
    await using extracted = await extractBuiltClawArtifact(artifact);
    for (const file of review.files) {
      expect(await readFile(join(extracted.packageRoot, file.path), "utf8")).toBe(file.content);
    }
  });

  it.each(["draft", "publisher", "authority"])(
    "blocks publication when %s changes after review",
    async (change) => {
      const fixture = await publicationFixture();
      const review = await fixture.review();
      if (change === "draft") {
        await fixture.write({
          ...proposal,
          scope: { ...proposal.scope, authority: "Changed authority" },
        });
      }
      if (change === "publisher") {
        fixture.identity.publisher = "another-person";
      }
      if (change === "authority") {
        fixture.identity.revoke = true;
      }
      const result = await fixture.publish(review.reviewToken);
      expect(result[0]).toBe(false);
      expect(result[2]).toMatchObject({
        code: change === "authority" ? "FORBIDDEN" : "INVALID_REQUEST",
        message:
          change === "authority"
            ? "Create, review, and publish Claws from an active administrator Control UI connection."
            : "The draft or publisher changed. Review the current files before publishing.",
      });
      expect(fixture.posts).toBe(0);
    },
  );
});
