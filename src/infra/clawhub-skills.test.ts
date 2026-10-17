// Verifies ClawHub skill icons, telemetry, metadata, verification, and cards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClawHubPluginInstallTelemetry } from "./clawhub-packages.js";
import {
  fetchClawHubSkillCard,
  fetchClawHubSkillCatalog,
  fetchClawHubSkillDetail,
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillSecurityVerdicts,
  fetchClawHubSkillVerification,
  reportClawHubSkillInstallTelemetry,
  searchClawHubSkills,
} from "./clawhub-skills.js";

function searchRow(slug: string, ownerHandle = "acme", overrides = {}) {
  return {
    score: 1,
    slug,
    ownerHandle,
    displayName: slug,
    source: "clawhub",
    install: { kind: "clawhub", reference: `${ownerHandle}/${slug}` },
    ...overrides,
  };
}
function captureResponse(response: Response) {
  let url: URL;
  let init: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, options) => {
    url = new URL(input instanceof Request ? input.url : String(input));
    init = options;
    return response;
  };
  return {
    fetchImpl,
    get url() {
      return url;
    },
    get init() {
      return init;
    },
  };
}
function jsonRequest(body: unknown) {
  return captureResponse(Response.json(body));
}
function expectRoute(url: URL, pathname: string, params: Record<string, string>) {
  expect(url.pathname).toBe(pathname);
  for (const [key, value] of Object.entries(params)) {
    expect(url.searchParams.get(key)).toBe(value);
  }
}
function telemetryRequest() {
  const request = captureResponse(new Response(null, { status: 200 }));
  return {
    fetchImpl: request.fetchImpl,
    body: () => {
      const body = request.init?.body;
      expect(typeof body).toBe("string");
      if (typeof body !== "string") {
        throw new Error("Expected JSON request body");
      }
      return JSON.parse(body) as unknown;
    },
  };
}
const trendingWeather = {
  slug: "weather",
  displayName: "Weather",
  source: "clawhub",
  official: true,
  publisher: { handle: "alice", official: true },
  install: { kind: "clawhub", reference: "alice/weather" },
  metrics: { updatedAt: 123 },
};

describe("clawhub skills", () => {
  afterEach(() => {
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_DISABLE_TELEMETRY;
    delete process.env.CLAWDHUB_DISABLE_TELEMETRY;
  });

  it("rejects skill icons outside the configured hosted-icon route", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        results: [
          searchRow("external", "acme", {
            icon: `https://tracker.example/api/v1/skill-icons/${"a".repeat(64)}`,
          }),
          searchRow("wrong-path", "acme", {
            icon: "https://registry.example/icon.png",
          }),
        ],
      });

    await expect(
      searchClawHubSkills({ query: "icons", baseUrl: "https://registry.example", fetchImpl }),
    ).resolves.toMatchObject([{ icon: undefined }, { icon: undefined }]);
  });

  it("keeps each search result on its own source and marks which ones are install-only", async () => {
    // Shape copied from a live https://clawhub.ai/api/v1/search response: the origin of a result
    // arrives under `install`, never as a flat `installRef`.
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        results: [
          searchRow("email", "alice", { score: 2 }),
          searchRow("email", "bob"),
          searchRow("weather", "openclaw", {
            source: "skills-sh",
            install: { kind: "skills-sh", reference: "skills-sh:openclaw/skills/weather" },
          }),
          searchRow("github-backed", "openclaw", {
            install: { kind: "github", reference: "openclaw/github-backed" },
          }),
        ],
      });

    await expect(
      searchClawHubSkills({ query: "email", baseUrl: "https://registry.example", fetchImpl }).then(
        (results) =>
          results.map((entry) => ({
            installRef: entry.installRef,
            installOnly: entry.installOnly,
            trustState: entry.trustState,
          })),
      ),
    ).resolves.toEqual([
      { installRef: "@alice/email", installOnly: undefined, trustState: undefined },
      { installRef: "@bob/email", installOnly: undefined, trustState: undefined },
      // The external row keeps its own reference and stays out of detail; rewriting it to
      // `@openclaw/weather` would install a different publisher's skill.
      {
        installRef: "skills-sh:openclaw/skills/weather",
        installOnly: true,
        trustState: "not-scanned-by-clawhub",
      },
      { installRef: "@openclaw/github-backed", installOnly: undefined, trustState: undefined },
    ]);
  });

  it("drops rows whose source or reference cannot be identified", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        results: [
          // External row without its own reference: publishing it under `@acme/weather` would
          // install a different publisher's skill, and there is no other identity to install.
          searchRow("weather", "acme", {
            source: "skills-sh",
            install: { kind: "skills-sh", reference: null },
          }),
          // Native row without a publisher: every action on the bare slug answers 409.
          searchRow("orphan", "acme", {
            ownerHandle: undefined,
            install: { kind: "clawhub", reference: "orphan" },
          }),
          // Unknown source: nothing here says which artifact an install would resolve.
          searchRow("mystery", "acme", {
            source: "future-registry",
            install: { kind: "future-registry", reference: "acme/mystery" },
          }),
          // A known source still needs a supported delivery mechanism.
          searchRow("future-install", "acme", {
            install: { kind: "future-transport", reference: "acme/future-install" },
          }),
          searchRow("keep"),
        ],
      });

    await expect(
      searchClawHubSkills({
        query: "weather",
        baseUrl: "https://registry.example",
        fetchImpl,
      }).then((results) => results.map((entry) => entry.installRef)),
    ).resolves.toEqual(["@acme/keep"]);
  });

  it("browses the full skill catalog with listing flags and publisher-qualified identity", async () => {
    let requestedUrl: URL | undefined;
    const result = await fetchClawHubSkillCatalog({
      baseUrl: "https://registry.example",
      cursor: "skillcat:next",
      officialOnly: true,
      limit: 25,
      fetchImpl: async (input) => {
        requestedUrl = new URL(input instanceof Request ? input.url : String(input));
        return Response.json({
          items: [true, false, undefined].map((isOfficial, index) => ({
            family: "skill",
            name: "email",
            displayName: "Email",
            ownerHandle: ["alice", "bob", "charlie"][index],
            isOfficial,
            latestVersion: index === 0 ? "1.2.3" : null,
            updatedAt: 123,
          })),
          nextCursor: "skillcat:following",
        });
      },
    });

    expect(requestedUrl?.pathname).toBe("/api/v1/packages");
    expect(Object.fromEntries(requestedUrl!.searchParams)).toEqual({
      family: "skill",
      sort: "downloads",
      isOfficial: "true",
      limit: "25",
      cursor: "skillcat:next",
    });
    expect(result.nextCursor).toBe("skillcat:following");
    expect(result.items).toMatchObject([
      { installRef: "@alice/email", official: true, version: "1.2.3" },
      { installRef: "@bob/email", official: false, version: undefined },
      { installRef: "@charlie/email", official: undefined },
    ]);
  });

  it("pages canonical trending while preserving external installation identity", async () => {
    let requestedUrl: URL | undefined;
    const result = await fetchClawHubSkillCatalog({
      baseUrl: "https://registry.example",
      feed: "trending",
      cursor: "snapshot:next",
      fetchImpl: async (input) => {
        requestedUrl = new URL(input instanceof Request ? input.url : String(input));
        return Response.json({
          items: [
            {
              source: "skills-sh",
              slug: "email",
              displayName: "Email",
              publisher: null,
              official: false,
              install: { kind: "skills-sh", reference: "skills-sh:alice/skills/email" },
              metrics: { updatedAt: 456 },
            },
          ],
          nextCursor: null,
        });
      },
    });
    expect(requestedUrl?.pathname).toBe("/api/v1/trending");
    expect(Object.fromEntries(requestedUrl!.searchParams)).toEqual({
      kind: "skills",
      limit: "100",
      cursor: "snapshot:next",
    });
    expect(result).toMatchObject({
      items: [
        {
          installRef: "skills-sh:alice/skills/email",
          installOnly: true,
          trustState: "not-scanned-by-clawhub",
          updatedAt: 456,
        },
      ],
    });
    expect(result.nextCursor).toBeUndefined();
  });

  it("searches listing metadata and resolves trending publisher badges to the listing flag", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedUrls.push(url);
      const listing = {
        family: "skill",
        name: "weather",
        displayName: "Weather",
        ownerHandle: "alice",
        isOfficial: false,
        latestVersion: "1.0.0",
        updatedAt: 123,
      };
      if (url.pathname === "/api/v1/packages/search") {
        return Response.json({ results: [{ score: 9, package: listing }] });
      }
      if (url.pathname === "/api/v1/packages/weather") {
        return Response.json({ package: listing });
      }
      return Response.json({
        items: [trendingWeather],
        nextCursor: "snapshot:next",
      });
    };
    await expect(
      fetchClawHubSkillCatalog({ query: "weather", officialOnly: true, fetchImpl }),
    ).resolves.toMatchObject({
      items: [{ installRef: "@alice/weather", score: 9, official: false }],
    });
    expect(requestedUrls[0]?.pathname).toBe("/api/v1/packages/search");
    expect(Object.fromEntries(requestedUrls[0]!.searchParams)).toEqual({
      family: "skill",
      q: "weather",
      isOfficial: "true",
      limit: "100",
    });
    await expect(fetchClawHubSkillCatalog({ feed: "trending", fetchImpl })).resolves.toMatchObject({
      items: [{ installRef: "@alice/weather", official: false }],
      nextCursor: "snapshot:next",
    });
    expect(requestedUrls[2]?.pathname).toBe("/api/v1/packages/weather");
    expect(Object.fromEntries(requestedUrls[2]!.searchParams)).toEqual({
      family: "skill",
      ownerHandle: "alice",
    });
    await expect(
      fetchClawHubSkillCatalog({
        feed: "trending",
        fetchImpl: async (input) =>
          (input instanceof Request ? input.url : String(input)).includes(
            "/api/v1/packages/weather",
          )
            ? Response.json({ package: null })
            : fetchImpl(input),
      }),
    ).rejects.toThrow("Malformed ClawHub skill listing");
  });

  it.each([{ family: "code-plugin" }, { ownerHandle: "bob" }])(
    "does not borrow official status from mismatched trending metadata: %j",
    async (mismatch) => {
      const result = await fetchClawHubSkillCatalog({
        feed: "trending",
        fetchImpl: async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/api/v1/packages/weather") {
            return Response.json({
              package: {
                family: "skill",
                name: "weather",
                ownerHandle: "alice",
                isOfficial: true,
                ...mismatch,
              },
            });
          }
          return Response.json({
            items: [trendingWeather],
          });
        },
      });
      expect(result.items).toMatchObject([{ installRef: "@alice/weather", official: undefined }]);
    },
  );

  it("rejects malformed catalog envelopes and unsupported search pagination", async () => {
    for (const response of [{}, { items: null }, { items: [null] }, { items: [], nextCursor: 1 }]) {
      await expect(
        fetchClawHubSkillCatalog({ fetchImpl: async () => Response.json(response) }),
      ).rejects.toThrow("Malformed ClawHub");
    }
    await expect(fetchClawHubSkillCatalog({ query: "email", cursor: "next" })).rejects.toThrow(
      "does not support a cursor",
    );
    await expect(
      fetchClawHubSkillCatalog({ query: "email", fetchImpl: async () => Response.json({}) }),
    ).rejects.toThrow("Malformed ClawHub");
  });

  it("preserves the legacy telemetry opt-out when the primary env is blank", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "   ";
    process.env.CLAWDHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "calendar",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends canonical plugin install telemetry", async () => {
    const request = telemetryRequest();

    await reportClawHubPluginInstallTelemetry({
      token: "test-token",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
      fetchImpl: request.fetchImpl,
    });

    expect(request.body()).toEqual({
      event: "plugin_install",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
    });
  });

  it("preserves skills-sh references in install telemetry", async () => {
    const request = telemetryRequest();

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "weather",
      version: "a".repeat(40),
      requestedReference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
      fetchImpl: request.fetchImpl,
    });

    expect(request.body()).toMatchObject({
      event: "install",
      slug: "weather",
      version: "a".repeat(40),
      reference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
    });
  });

  it("lets a nonblank primary telemetry setting override the legacy opt-out", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "false";
    process.env.CLAWDHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "calendar",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends owner-qualified skill detail lookups as slug plus ownerHandle", async () => {
    const request = jsonRequest({
      skill: {
        slug: "weather",
        icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    });

    await expect(
      fetchClawHubSkillDetail({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: request.fetchImpl,
      }),
    ).resolves.toMatchObject({
      skill: {
        slug: "weather",
        icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    });

    expectRoute(request.url, "/api/v1/skills/weather", { ownerHandle: "demo-owner" });
  });

  it("sends skills-sh references to the ClawHub install resolver", async () => {
    const reference = "skills-sh:openclaw/skills/weather";
    const request = jsonRequest({
      ok: true,
    });

    await fetchClawHubSkillInstallResolution({
      slug: "weather",
      requestedReference: reference,
      fetchImpl: request.fetchImpl,
    });

    expectRoute(request.url, "/api/v1/skills/weather/install", { reference });
  });

  it("sends owner-qualified skill verification lookups without resolved auth when requested", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    const request = jsonRequest({
      schema: "clawhub.skill.verify.v1",
    });

    await expect(
      fetchClawHubSkillVerification({
        slug: "weather",
        ownerHandle: "demo-owner",
        version: "1.0.0",
        skipAuth: true,
        fetchImpl: request.fetchImpl,
      }),
    ).resolves.toMatchObject({ schema: "clawhub.skill.verify.v1" });

    expectRoute(request.url, "/api/v1/skills/weather/verify", {
      ownerHandle: "demo-owner",
      version: "1.0.0",
    });
    expect(new Headers(request.init?.headers).get("Authorization")).toBeNull();
  });

  it("posts bulk skill security verdict requests", async () => {
    const envelope = {
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "agentreceipt",
          slug: "agentreceipt",
          requestedVersion: "1.2.3",
          version: "1.2.3",
          security: { status: "clean", passed: true },
        },
      ],
    };
    const request = jsonRequest(envelope);

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }],
        fetchImpl: request.fetchImpl,
      }),
    ).resolves.toEqual(envelope);

    const { url, init: requestedInit } = request;
    expect(url.pathname).toBe("/api/v1/skills/-/security-verdicts");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(requestedInit?.body).toBe(
      JSON.stringify({
        items: [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }],
      }),
    );
  });

  it("fetches generated Skill Card markdown and applies tag queries", async () => {
    const request = captureResponse(
      new Response("# Agent Receipt\n\nVerified by ClawHub.\n", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );

    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        tag: "latest",
        fetchImpl: request.fetchImpl,
      }),
    ).resolves.toBe("# Agent Receipt\n\nVerified by ClawHub.\n");

    expectRoute(request.url, "/api/v1/skills/agentreceipt/card", { tag: "latest" });
    expect(request.url.searchParams.has("version")).toBe(false);
  });

  it("fetches generated Skill Card markdown from an exact verified card URL", async () => {
    const request = captureResponse(
      new Response("# Agent Receipt\n", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );

    await expect(
      fetchClawHubSkillCard({
        url: "https://cards.example.test/generated/agentreceipt.md",
        baseUrl: "https://clawhub.ai",
        fetchImpl: request.fetchImpl,
      }),
    ).resolves.toBe("# Agent Receipt\n");

    expect(request.url.href).toBe("https://cards.example.test/generated/agentreceipt.md");
  });

  it("wraps non-200 skill card responses", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("card missing", { status: 404 }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/agentreceipt/card failed (404): card missing");
  });

  it("rejects oversized generated Skill Card markdown", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1)),
      }),
    ).rejects.toThrow(
      "ClawHub skill card for agentreceipt exceeded 262144 bytes (262145 bytes received)",
    );
  });
});
