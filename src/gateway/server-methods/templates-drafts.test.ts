import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validateTemplateDraftDocument } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  templateDraftRevision,
  createTemplateDraft,
  MAX_TEMPLATE_DRAFT_BYTES,
} from "../../templates/draft.js";
import { createResearchBriefProposal } from "../../templates/draft.test-support.js";
import { extractBuiltTemplateArtifact } from "../../templates/project-build.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayClient } from "./client-types.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { templatesDraftsHandlers } from "./templates-drafts.js";
import type { RespondFn } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function requestDraft(
  operation: "create" | "save" | "review" | "publish",
  workspace: string,
  params: Record<string, unknown> = {},
  condition?: string,
  connections?: ReadonlySet<string>,
) {
  const method = `templates.drafts.${operation}`;
  const replies: Parameters<RespondFn>[] = [];
  // SAFETY: These are the live socket fields read by draft authority.
  const client = {
    connId: "draft-author",
    authenticatedUserProfile: gatewayProfile("creator"),
    connect: { role: "operator", scopes: ["operator.admin"] },
    internal: { syntheticClient: condition === "synthetic", operatorRoleActor: { kind: "system" } },
  } as GatewayClient;
  await expectDefined(
    templatesDraftsHandlers[method],
    method,
  )({
    req: { type: "req", id: operation, method },
    params: { agentId: "research", ...params },
    client,
    context: createDirectChatContext({
      getRuntimeConfig: () => ({
        agents: { entries: { research: { workspace } } },
        gateway: { controlUi: { experimental: { templates: condition !== "labs-off" } } },
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

describe("Template draft human authority", () => {
  it("registers draft methods only for administrators", () => {
    for (const method of Object.keys(templatesDraftsHandlers)) {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(
        authorizeOperatorScopesForMethod(method, ["operator.read", "operator.write"]).allowed,
      ).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"]).allowed).toBe(true);
    }
  });

  it("saves a maximum-size draft while retaining revision conflicts", async () => {
    const size = MAX_TEMPLATE_DRAFT_BYTES;
    const workspace = tempDirs.make("openclaw-large-template-draft-");
    const draft = await createTemplateDraft(workspace);
    const document: unknown = JSON.parse(await readFile(draft.path, "utf8"));
    assert(validateTemplateDraftDocument(document));
    const file = { path: "notes.md", content: "" };
    document.files = [file];
    const overhead = Buffer.byteLength(JSON.stringify(document));
    file.content = "a".repeat(size - overhead);
    const original = JSON.stringify(document);
    const edited = original.replace('"my-template"', '"my-edit"');
    await writeFile(draft.path, original);
    const save = (content: string) =>
      requestDraft("save", workspace, {
        draftId: draft.draftId,
        content,
        expectedRevision: templateDraftRevision(original),
      });
    expect(Buffer.byteLength(original)).toBe(size);
    const result = await save(edited);
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({ revision: templateDraftRevision(edited) });
    expect(await readFile(draft.path, "utf8")).toBe(edited);
    expect((await save(original))[0]).toBe(false);
    expect(await readFile(draft.path, "utf8")).toBe(edited);
  });

  it.each(["synthetic", "disconnected", "labs-off"])(
    "does not turn an agent-authored proposal into %s publication authority",
    async (condition) => {
      const reply = await requestDraft(
        "publish",
        "/not-a-real-template-draft-workspace",
        {
          draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
          reviewToken: "a".repeat(64),
        },
        condition,
      );
      expect(reply[0]).toBe(false);
      expect(reply[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it.each(["synthetic", "disconnected", "labs-off"])(
    "refuses %s creation before touching the workspace",
    async (condition) => {
      const reply = await requestDraft(
        "create",
        "/not-a-real-template-draft-workspace",
        {},
        condition,
      );
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
    return { path: file.path, content: file.content, workspacePaths: file.workspacePaths };
  });
  return { reviewToken: payload.reviewToken, name: payload.name, files, items: payload.items };
}

const proposal = createResearchBriefProposal();
let registryRequest: (request: Request) => Promise<Response | undefined>;
let registryServer: Awaited<ReturnType<typeof reserveTestPortListener>>;
let registryUrl: string;
const registryErrors: unknown[] = [];

async function publicationFixture(name = "@maker/research-brief") {
  const workspaceDir = tempDirs.make("template-draft-publish-");
  const draft = await createTemplateDraft(workspaceDir);
  const connections = new Set(["draft-author"]);
  const uploads: Buffer[] = [];
  let posts = 0;
  const identity = { publisher: "maker", revoke: false };
  const registry = {
    visible: true,
    digest: "",
    pending: false,
    blocked: false,
    revoke: false,
    attemptStatus: "pending_checks",
    attemptName: name,
    reads: 0,
    dropUploadResponse: false,
    postRevoke: false,
  };
  const write = (document = proposal) => writeFile(draft.path, JSON.stringify(document));
  await write();
  registryRequest = async (request) => {
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
    if (request.method === "GET") {
      registry.reads += 1;
      if (registry.revoke) {
        connections.delete("draft-author");
      }
      if (!registry.visible) {
        return new Response("Version not found", { status: 404 });
      }
      if (request.url.includes("/publish/attempts/")) {
        return Response.json({
          attemptId: "fixture_attempt",
          name: registry.attemptName,
          version: "0.1.0",
          artifactSha256: registry.digest,
          status: registry.attemptStatus,
          publicationStatus:
            registry.attemptStatus === "finalized"
              ? "published"
              : ["blocked", "failed", "expired"].includes(registry.attemptStatus)
                ? registry.attemptStatus
                : "pending",
        });
      }
      if (request.url.endsWith("/security")) {
        return Response.json({
          package: { name, family: "template" },
          release: { version: "0.1.0", artifactSha256: registry.digest },
          overview: "Fixture audit",
          securityAuditUrl: "https://registry.example.test/audit",
          trust: {
            pending: registry.pending,
            blockedFromDownload: registry.blocked,
            stale: false,
            reasons: [],
          },
        });
      }
      return Response.json({
        package: { name, family: "template" },
        version: { version: "0.1.0", artifact: { sha256: registry.digest } },
      });
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
      family: "template",
      channel: "community",
      ownerHandle: "maker",
      expectedArtifactSha256: digest,
    });
    uploads.push(bytes);
    registry.digest = digest;
    if (registry.postRevoke) {
      connections.delete("draft-author");
    }
    if (registry.dropUploadResponse) {
      return undefined;
    }
    return Response.json({
      ok: true,
      artifactSha256: digest,
      publicationStatus: "pending",
      attemptId: "fixture_attempt",
    });
  };
  return {
    workspaceDir,
    draft,
    uploads,
    get posts() {
      return posts;
    },
    identity,
    registry,
    write,
    disconnect: () => connections.clear(),
    check: (params: Record<string, unknown>) =>
      requestDraft(
        "review",
        workspaceDir,
        { draftId: draft.draftId, checkPublication: true, ...params },
        undefined,
        connections,
      ),
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

describe("Template draft reviewed publication", () => {
  beforeAll(async () => {
    registryServer = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((incoming, outgoing) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) {
              chunks.push(Buffer.from(chunk));
            }
            const response = await registryRequest(
              new Request(`${registryUrl}${incoming.url}`, {
                method: incoming.method,
                headers: {
                  authorization: incoming.headers.authorization ?? "",
                  "content-type": incoming.headers["content-type"] ?? "",
                },
                ...(incoming.method === "POST"
                  ? { body: new Uint8Array(Buffer.concat(chunks)) }
                  : {}),
              }),
            );
            if (!response) {
              return outgoing.destroy();
            }
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            return outgoing.end(new Uint8Array(await response.arrayBuffer()));
          })().catch((error: unknown) => {
            registryErrors.push(error);
            outgoing.destroy();
          });
        }),
    });
    registryUrl = `http://127.0.0.1:${registryServer.claim.port}`;
  });
  afterAll(async () => {
    await registryServer.releaseListener();
    await registryServer.claim.release();
  });
  beforeEach(() => {
    vi.stubEnv("CLAWHUB_TOKEN", "fixture-personal-token");
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", registryUrl);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    expect(registryErrors.splice(0)).toEqual([]);
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
skills:
  - { ref: "@maker/sources", version: 1.2.3 }
plugins:
  - { ref: "@maker/github", version: 2.0.0 }
mcpServers: { research: { command: research-mcp } }
automations:
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
        "package:skill:clawhub:@maker/sources",
        "package:plugin:clawhub:@maker/github",
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
    expect(review.files.find((file) => file.path === "workspace/AGENTS.md")).toEqual({
      path: "workspace/AGENTS.md",
      content: "Keep citations.",
      workspacePaths: ["AGENTS.md"],
    });
    expect(review.items).toEqual([
      expect.objectContaining({ id: "file:workspace/AGENTS.md", included: true }),
      ...choices.excluded.map((id) => expect.objectContaining({ id, included: false })),
    ]);
    for (const [kind, details] of [
      ["skill", { requirement: { source: "clawhub", ref: "@maker/sources", version: "1.2.3" } }],
      ["plugin", { requirement: { source: "clawhub", ref: "@maker/github", version: "2.0.0" } }],
      [
        "automation",
        {
          automation: {
            message: "Recap research.",
            schedule: { cron: "0 9 * * 1", timezone: "UTC" },
            session: "isolated",
            enabled: true,
          },
        },
      ],
    ] as const) {
      expect(review.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind, ...details })]),
      );
    }
    const template = review.files.find((file) => file.path === "CLAW.md")!.content;
    expect(template).toContain("description: Researches public sources for a new user.");
    expect(template).not.toMatch(
      /checklist|@maker\/sources|@maker\/github|research-mcp|weekly-recap/,
    );

    const rejected = await fixture.publish(review.reviewToken, {
      choices: { ...choices, excluded: [] },
    });
    expect(rejected[0]).toBe(false);
    expect(rejected[2]).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: true,
      details: { templatePublication: { effect: "none", code: "draft_review_required" } },
      message: "The draft or publisher changed. Review the current files before publishing.",
    });
    expect(fixture.posts).toBe(0);
    const result = await fixture.publish(review.reviewToken, { choices });
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({
      name: review.name,
      url: `${registryUrl}/maker/templates/public-researcher`,
      publicationStatus: "pending",
    });
    expect(uploads).toHaveLength(1);
    const artifact = join(workspaceDir, "published.tgz");
    await writeFile(artifact, uploads[0]!);
    await using extracted = await extractBuiltTemplateArtifact(artifact);
    for (const file of review.files) {
      expect(await readFile(join(extracted.packageRoot, file.path), "utf8")).toBe(file.content);
    }
  });

  it("does not infer an attempt from matching public release reads without an attempt ID", async () => {
    const fixture = await publicationFixture();
    const review = await fixture.review();
    expect((await fixture.publish(review.reviewToken))[0]).toBe(true);
    const result = await fixture.check({ reviewToken: review.reviewToken });
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({ publicationState: { status: "unconfirmed" } });
    expect(fixture.registry.reads).toBe(0);
    expect(fixture.posts).toBe(1);
  });

  it("rejects an attempt status check without the original review token", async () => {
    const fixture = await publicationFixture();
    const result = await fixture.check({ attemptId: "fixture_attempt" });
    expect(result[0]).toBe(false);
    expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fixture.registry.reads).toBe(0);
    expect(fixture.posts).toBe(0);
  });

  it.each([
    ["pending_checks", "pending"],
    ["finalized", "published"],
    ["blocked", "failed"],
    ["failed", "failed"],
    ["expired", "failed"],
    ["not-found", "unconfirmed"],
    ["wrong-artifact", "unconfirmed"],
    ["wrong-name", "unconfirmed"],
    ["blocked-public-release", "unconfirmed"],
  ])("observes %s without resubmitting the accepted attempt", async (condition, expected) => {
    const fixture = await publicationFixture();
    const review = await fixture.review();
    const accepted = await fixture.publish(review.reviewToken);
    expect(accepted[1]).toMatchObject({
      attemptId: "fixture_attempt",
      publicationStatus: "pending",
    });
    fixture.registry.attemptStatus =
      condition === "blocked-public-release"
        ? "finalized"
        : ["pending_checks", "finalized", "blocked", "failed", "expired"].includes(condition)
          ? condition
          : "pending_checks";
    if (condition === "not-found") {
      fixture.registry.visible = false;
    }
    if (condition === "wrong-artifact") {
      fixture.registry.digest = "0".repeat(64);
    }
    if (condition === "wrong-name") {
      fixture.registry.attemptName = "@maker/another-template";
    }
    if (condition === "blocked-public-release") {
      fixture.registry.blocked = true;
    }
    const result = await fixture.check({
      reviewToken: review.reviewToken,
      attemptId: "fixture_attempt",
    });
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({ publicationState: { status: expected } });
    expect(fixture.posts).toBe(1);
  });

  it.each(["draft", "publisher", "registry", "authority"])(
    "does not accept status for a changed %s binding",
    async (condition) => {
      const fixture = await publicationFixture();
      const review = await fixture.review();
      if (condition === "draft") {
        await fixture.write({ ...proposal, name: "changed-brief" });
      }
      if (condition === "publisher") {
        fixture.identity.publisher = "another-person";
      }
      if (condition === "registry") {
        vi.stubEnv("OPENCLAW_CLAWHUB_URL", `${registryUrl}/another-registry`);
      }
      if (condition === "authority") {
        fixture.disconnect();
      }
      const result = await fixture.check({ reviewToken: review.reviewToken });
      expect(result[0]).toBe(false);
      expect(fixture.posts).toBe(0);
      expect(fixture.registry.reads).toBe(0);
    },
  );

  it("drops a late status read when live authority is revoked", async () => {
    const fixture = await publicationFixture();
    const review = await fixture.review();
    fixture.registry.revoke = true;
    const result = await fixture.check({
      reviewToken: review.reviewToken,
      attemptId: "fixture_attempt",
    });
    expect(result[0]).toBe(false);
    expect(result[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.posts).toBe(0);
  });

  it("does not claim no write when live authority is revoked after upload", async () => {
    const fixture = await publicationFixture();
    const review = await fixture.review();
    fixture.registry.postRevoke = true;
    const result = await fixture.publish(review.reviewToken);
    expect(result[0]).toBe(false);
    expect(result[2]).toMatchObject({
      code: "FORBIDDEN",
      retryable: false,
      details: { templatePublication: { effect: "unconfirmed", code: "human_required" } },
    });
    expect(fixture.posts).toBe(1);
  });

  it("never makes an upload retryable after the registry receives it but closes the socket", async () => {
    const fixture = await publicationFixture();
    const review = await fixture.review();
    fixture.registry.dropUploadResponse = true;
    const result = await fixture.publish(review.reviewToken);
    expect(result[0]).toBe(false);
    expect(result[2]).toMatchObject({
      retryable: false,
      details: { templatePublication: { effect: "unconfirmed", code: "publication_unconfirmed" } },
    });
    expect(fixture.posts).toBe(1);
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
            ? "Create, review, and publish Templates from an active administrator Control UI connection."
            : "The draft or publisher changed. Review the current files before publishing.",
      });
      expect(fixture.posts).toBe(0);
    },
  );
});
