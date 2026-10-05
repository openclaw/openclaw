// Boundary proof for issue #117633: two publishers share one ClawHub slug, and the reference a
// client picks from skills.search must reach the outbound ClawHub request unchanged. Only the
// HTTP layer is faked here; search, the Gateway handlers, and the detail client are real.

import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsDetailResultSchema } from "../../../packages/gateway-protocol/src/schema/skill-detail.js";

const installSkillFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: vi.fn(),
}));

vi.mock("../../skills/lifecycle/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/lifecycle/clawhub.js")>()),
  installSkillFromClawHub: (...args: unknown[]) => installSkillFromClawHubMock(...args),
}));

const { skillsHandlers } = await import("./skills.js");
const { callGatewayHandler } = await import("./skills.test-helpers.js");

const SLUG = "imap-smtp-email";
const PUBLISHERS = ["gzlicanyi", "wangchenyu8"] as const;

function searchPayload() {
  return {
    results: [
      ...PUBLISHERS.map((ownerHandle, index) => ({
        score: 6120 - index,
        slug: SLUG,
        registry: "https://unrelated.example",
        ownerHandle,
        displayName: SLUG,
        summary: `Email skill by ${ownerHandle}`,
        version: "1.0.0",
        source: "clawhub",
        install: { kind: "clawhub", reference: `${ownerHandle}/${SLUG}` },
      })),
      // An external source that names its own reference instead of a registry publisher.
      {
        score: 6100,
        slug: SLUG,
        ownerHandle: "acme",
        displayName: SLUG,
        summary: "Email skill from skills.sh",
        version: "1.0.0",
        source: "skills-sh",
        install: { kind: "skills-sh", reference: `skills-sh:acme/tools/${SLUG}` },
      },
    ],
  };
}

let requestedUrls: string[] = [];
let unavailableRelease = false;
let noHostedRelease = false;
let malformedScan = false;
let wrongIdentity: "slug" | "owner" | "version" | undefined;

function fakeClawHub(input: string): Response {
  const url = new URL(input);
  requestedUrls.push(input);
  if (url.pathname === "/api/v1/search") {
    return Response.json(searchPayload());
  }
  if (url.pathname === "/api/v1/trending") {
    return Response.json({
      items: searchPayload()
        .results.filter((_, index) => index !== 1)
        .map(({ ownerHandle, score: _score, ...entry }) =>
          Object.assign(entry, {
            publisher: entry.source === "clawhub" ? { handle: ownerHandle } : null,
            metrics: { updatedAt: 123 },
          }),
        ),
    });
  }
  if (url.pathname.startsWith(`/api/v1/skills/${SLUG}/versions/`)) {
    if (unavailableRelease) {
      return new Response("Version not found", { status: 404 });
    }
    return Response.json({
      version: {
        version:
          wrongIdentity === "version"
            ? "9.9.9"
            : decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
        createdAt: 1,
        changelog: "Selected release notes",
        security: malformedScan
          ? { status: "", hasWarnings: "true" }
          : {
              status: "suspicious",
              hasWarnings: true,
              hasScanResult: true,
              checkedAt: 3,
              scanners: { llm: { summary: "Review network access." } },
            },
      },
    });
  }
  if (url.pathname === `/api/v1/skills/${SLUG}/card`) {
    if (unavailableRelease) {
      return new Response("Skill Card not found", { status: 404 });
    }
    return new Response(`# Email skill ${url.searchParams.get("version")}\nFull card content.`);
  }
  if (url.pathname === `/api/v1/skills/${SLUG}`) {
    const ownerHandle = url.searchParams.get("ownerHandle");
    if (!ownerHandle) {
      // Real ClawHub refuses to guess a publisher instead of returning an arbitrary match.
      return Response.json(
        { code: "AMBIGUOUS_SKILL_SLUG", message: `Found multiple skills with the slug "${SLUG}"` },
        { status: 409 },
      );
    }
    return Response.json({
      skill: {
        slug: wrongIdentity === "slug" ? "other-skill" : SLUG,
        displayName: SLUG,
        createdAt: 1,
        updatedAt: 2,
      },
      owner: {
        handle: wrongIdentity === "owner" ? "other-publisher" : ownerHandle,
        displayName: ownerHandle,
      },
      latestVersion: noHostedRelease
        ? null
        : { version: "2.0.0", createdAt: 2, changelog: "Current release" },
      metadata: { setup: [{ key: "EMAIL_TOKEN", required: true }], os: ["linux"] },
    });
  }
  throw new Error(`unexpected ClawHub request: ${input}`);
}

const callSkillsHandler = (method: string, params: Record<string, unknown>) =>
  callGatewayHandler(skillsHandlers, method, params);

describe("ClawHub publisher identity across skills.search, skills.detail, and skills.install", () => {
  beforeEach(() => {
    requestedUrls = [];
    unavailableRelease = false;
    noHostedRelease = false;
    malformedScan = false;
    wrongIdentity = undefined;
    installSkillFromClawHubMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => fakeClawHub(input instanceof URL ? input.href : input)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { configured: undefined, registry: "https://clawhub.ai" },
    { configured: "https://registry.example/", registry: "https://registry.example" },
  ])(
    "preserves publisher and registry identity from $registry",
    async ({ configured, registry }) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", configured);
      vi.stubEnv("CLAWHUB_URL", undefined);
      const { ok, response } = await callSkillsHandler("skills.search", { query: SLUG });

      expect(ok).toBe(true);
      const results = (
        response as {
          results: { registry: string; installRef?: string; installOnly?: true }[];
        }
      ).results;
      expect(requestedUrls).toHaveLength(1);
      expect(new URL(expectDefined(requestedUrls[0], "search request")).origin).toBe(registry);
      expect(results.map((r) => r.registry)).toEqual([registry, registry, registry]);
      expect(results.map((r) => r.installRef)).toEqual([
        `@gzlicanyi/${SLUG}`,
        `@wangchenyu8/${SLUG}`,
        `skills-sh:acme/tools/${SLUG}`,
      ]);
      // Only the external row is install-only; the registry rows keep the review flow.
      expect(results.map((r) => r.installOnly)).toEqual([undefined, undefined, true]);
    },
  );

  it.each(PUBLISHERS)("reads detail for the selected publisher %s", async (ownerHandle) => {
    const { ok, response, error } = await callSkillsHandler("skills.detail", {
      slug: `@${ownerHandle}/${SLUG}`,
    });

    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect((response as { owner: { handle: string } }).owner.handle).toBe(ownerHandle);
    expect(response).toMatchObject({
      selectedRelease: { version: "2.0.0" },
      requirements: {
        status: "available",
        setup: [{ key: "EMAIL_TOKEN", required: true }],
        os: ["linux"],
      },
    });
    const detailUrl = expectDefined(
      requestedUrls.find((url) => url.includes(`/api/v1/skills/${SLUG}`)),
      "detail request",
    );
    expect(new URL(detailUrl).searchParams.get("ownerHandle")).toBe(ownerHandle);
  });

  it("reads the selected release card and scan without relabeling latest requirements", async () => {
    const { ok, response, error } = await callSkillsHandler("skills.detail", {
      slug: `@wangchenyu8/${SLUG}`,
      version: "1.0.0",
    });

    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(Value.Check(SkillsDetailResultSchema, response)).toBe(true);
    expect(response).toMatchObject({
      registry: "https://clawhub.ai",
      source: "clawhub",
      installRef: `@wangchenyu8/${SLUG}`,
      latestVersion: { version: "2.0.0" },
      selectedRelease: { version: "1.0.0", changelog: "Selected release notes" },
      card: { status: "available", content: "# Email skill 1.0.0\nFull card content." },
      requirements: { status: "unavailable" },
      security: {
        status: "available",
        scanStatus: "suspicious",
        summary: "Review network access.",
      },
      downloadability: { status: "unknown" },
    });
    for (const request of requestedUrls) {
      expect(new URL(request).searchParams.get("ownerHandle")).toBe("wangchenyu8");
    }
    expect(requestedUrls.map((request) => new URL(request).pathname)).toContain(
      `/api/v1/skills/${SLUG}/versions/1.0.0`,
    );
    const cardRequest = requestedUrls.find((request) =>
      new URL(request).pathname.endsWith("/card"),
    );
    expect(new URL(expectDefined(cardRequest, "card request")).searchParams.get("version")).toBe(
      "1.0.0",
    );
  });

  it("keeps listing metadata when selected release and card are unavailable", async () => {
    unavailableRelease = true;
    const { ok, response } = await callSkillsHandler("skills.detail", {
      slug: `@wangchenyu8/${SLUG}`,
      version: "0.1.0",
    });

    expect(ok).toBe(true);
    expect(Value.Check(SkillsDetailResultSchema, response)).toBe(true);
    expect(response).toMatchObject({
      skill: { slug: SLUG },
      selectedRelease: null,
      card: { status: "unavailable", reason: expect.stringContaining("404") },
      requirements: { status: "unavailable" },
      security: { status: "unavailable" },
      downloadability: { status: "unavailable" },
      warnings: [expect.stringContaining("404")],
    });
  });

  it("keeps source-backed availability unknown when a listing has no hosted release", async () => {
    noHostedRelease = true;
    const { ok, response } = await callSkillsHandler("skills.detail", {
      slug: `@wangchenyu8/${SLUG}`,
    });
    expect(ok).toBe(true);
    expect(Value.Check(SkillsDetailResultSchema, response)).toBe(true);
    expect(response).toMatchObject({
      skill: { slug: SLUG },
      selectedRelease: null,
      downloadability: { status: "unknown", reason: expect.stringContaining("source-backed") },
      card: { status: "unavailable" },
    });
    expect(requestedUrls).toHaveLength(1);
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
  });

  it.each(["slug", "owner"] as const)(
    "refuses registry detail with mismatched %s identity",
    async (identity) => {
      wrongIdentity = identity;
      const { ok, error } = await callSkillsHandler("skills.detail", {
        slug: `@wangchenyu8/${SLUG}`,
      });

      expect(ok).toBe(false);
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("different"),
      });
      expect(requestedUrls).toHaveLength(1);
    },
  );

  it("does not relabel a different release returned by the registry", async () => {
    wrongIdentity = "version";
    const { ok, response } = await callSkillsHandler("skills.detail", {
      slug: `@wangchenyu8/${SLUG}`,
      version: "2.0.0",
    });

    expect(ok).toBe(true);
    expect(response).toMatchObject({
      selectedRelease: null,
      security: { status: "unavailable" },
      requirements: { status: "unavailable" },
      downloadability: { status: "unknown", reason: expect.stringContaining("different release") },
      warnings: [expect.stringContaining("different release")],
    });
  });

  it("keeps a malformed optional scan out of the detail response", async () => {
    malformedScan = true;
    const { ok, response } = await callSkillsHandler("skills.detail", {
      slug: `@wangchenyu8/${SLUG}`,
      version: "1.0.0",
    });

    expect(ok).toBe(true);
    expect(Value.Check(SkillsDetailResultSchema, response)).toBe(true);
    expect(response).toMatchObject({
      selectedRelease: { version: "1.0.0" },
      card: { status: "available" },
      security: { status: "unavailable" },
    });
  });

  it.each([{}, { query: "   ", limit: 2 }])(
    "browses source-qualified trending skills for an empty query: %j",
    async (params) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://registry.example/");
      const { ok, response } = await callSkillsHandler("skills.search", params);

      expect(ok).toBe(true);
      expect(requestedUrls).toEqual([
        `https://registry.example/api/v1/trending?kind=skills&limit=${params.limit ?? 20}`,
      ]);
      expect(response).toMatchObject({
        results: [
          {
            registry: "https://registry.example",
            ownerHandle: PUBLISHERS[0],
            installRef: `@${PUBLISHERS[0]}/${SLUG}`,
            updatedAt: 123,
          },
          {
            registry: "https://registry.example",
            installRef: `skills-sh:acme/tools/${SLUG}`,
            installOnly: true,
            trustState: "not-scanned-by-clawhub",
          },
        ],
      });
    },
  );

  it("surfaces the ambiguous-slug error instead of picking a publisher for a bare slug", async () => {
    const { ok, error } = await callSkillsHandler("skills.detail", { slug: SLUG });

    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message)).toContain("AMBIGUOUS_SKILL_SLUG");
  });

  it("refuses external-source detail instead of reading a same-slug registry skill", async () => {
    // Install keeps the external source, so a bare-slug read here would let an operator review
    // one skill and install another. ClawHub has no source-qualified read endpoint yet.
    const { ok, error } = await callSkillsHandler("skills.detail", {
      slug: `skills-sh:openclaw/skills/${SLUG}`,
    });

    expect(ok).toBe(false);
    expect((error as { code?: string }).code).toBe("INVALID_REQUEST");
    expect(requestedUrls.some((url) => url.includes("/api/v1/skills/"))).toBe(false);
  });

  it("forwards the selected publisher reference to the install lifecycle unchanged", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: SLUG,
      version: "1.0.0",
      targetDir: `/tmp/workspace/skills/${SLUG}`,
    });

    const { ok } = await callSkillsHandler("skills.install", {
      source: "clawhub",
      slug: `@wangchenyu8/${SLUG}`,
    });

    expect(ok).toBe(true);
    expect(installSkillFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({ slug: `@wangchenyu8/${SLUG}` }),
    );
  });
});
