import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportClawHubPluginInstallTelemetry,
  fetchClawHubPackageArtifact,
  fetchClawHubPackageSecurity,
  resolveLatestVersionFromPackage,
  searchClawHubPackages,
} from "./clawhub-packages.js";
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
import {
  captureClawHubJson as jsonRequest,
  captureClawHubResponse as captureResponse,
} from "./clawhub.test-support.js";

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
function searchRows(query: string, results: unknown[]) {
  jsonRequest({ results });
  return searchClawHubSkills({ query, baseUrl: "https://registry.example" });
}
function expectRoute(url: URL, pathname: string, params: Record<string, string>) {
  expect(url.pathname).toBe(pathname);
  expect(Object.fromEntries(url.searchParams)).toEqual(params);
}
const telemetryRequest = () => captureResponse(new Response(null, { status: 200 }));
const trendingWeather = {
  slug: "weather",
  displayName: "Weather",
  source: "clawhub",
  official: true,
  publisher: { handle: "alice", official: true },
  install: { kind: "clawhub", reference: "alice/weather" },
  metrics: { updatedAt: 123 },
};
const listing = {
  family: "skill",
  name: "weather",
  displayName: "Weather",
  ownerHandle: "alice",
  isOfficial: false,
  latestVersion: "1.0.0",
  updatedAt: 123,
};
const catalog = (options: Parameters<typeof fetchClawHubSkillCatalog>[0] = {}) =>
  fetchClawHubSkillCatalog({ baseUrl: "https://registry.example", ...options });

describe("clawhub skills", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_DISABLE_TELEMETRY;
    delete process.env.CLAWDHUB_DISABLE_TELEMETRY;
  });

  it("rejects skill icons outside the configured hosted-icon route", async () => {
    const results = await searchRows("icons", [
      searchRow("external", "acme", {
        icon: `https://tracker.example/api/v1/skill-icons/${"a".repeat(64)}`,
      }),
      searchRow("wrong-path", "acme", { icon: "https://registry.example/icon.png" }),
    ]);
    expect(results).toMatchObject([{ icon: undefined }, { icon: undefined }]);
  });

  it("keeps each search result on its own source and marks which ones are install-only", async () => {
    const results = await searchRows("email", [
      searchRow("email", "alice", { score: 2 }),
      searchRow("email", "bob"),
      searchRow("weather", "openclaw", {
        source: "skills-sh",
        install: { kind: "skills-sh", reference: "skills-sh:openclaw/skills/weather" },
      }),
      searchRow("github-backed", "openclaw", {
        install: { kind: "github", reference: "openclaw/github-backed" },
      }),
    ]);
    expect(
      results.map(({ installRef, installOnly, trustState }) => ({
        installRef,
        installOnly,
        trustState,
      })),
    ).toEqual([
      { installRef: "@alice/email", installOnly: undefined, trustState: undefined },
      { installRef: "@bob/email", installOnly: undefined, trustState: undefined },
      {
        installRef: "skills-sh:openclaw/skills/weather",
        installOnly: true,
        trustState: "not-scanned-by-clawhub",
      },
      { installRef: "@openclaw/github-backed", installOnly: undefined, trustState: undefined },
    ]);
  });

  it("drops rows whose source or reference cannot be identified", async () => {
    const results = await searchRows("weather", [
      searchRow("weather", "acme", {
        source: "skills-sh",
        install: { kind: "skills-sh", reference: null },
      }),
      searchRow("orphan", "acme", {
        ownerHandle: undefined,
        install: { kind: "clawhub", reference: "orphan" },
      }),
      searchRow("mystery", "acme", {
        source: "future-registry",
        install: { kind: "future-registry", reference: "acme/mystery" },
      }),
      searchRow("future-install", "acme", {
        install: { kind: "future-transport", reference: "acme/future-install" },
      }),
      searchRow("keep"),
    ]);
    expect(results.map((entry) => entry.installRef)).toEqual(["@acme/keep"]);
  });

  it("browses the full skill catalog with listing flags and publisher-qualified identity", async () => {
    const request = jsonRequest({
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
    const result = await catalog({
      cursor: "skillcat:next",
      officialOnly: true,
      limit: 25,
    });

    expectRoute(request.url(), "/api/v1/packages", {
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
    const request = jsonRequest({
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
    const result = await catalog({
      feed: "trending",
      cursor: "snapshot:next",
    });
    expectRoute(request.url(), "/api/v1/trending", {
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
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    await expect(
      fetchClawHubSkillCatalog({ query: "weather", officialOnly: true }),
    ).resolves.toMatchObject({
      items: [{ installRef: "@alice/weather", score: 9, official: false }],
    });
    expectRoute(requestedUrls[0]!, "/api/v1/packages/search", {
      family: "skill",
      q: "weather",
      isOfficial: "true",
      limit: "100",
    });
    await expect(fetchClawHubSkillCatalog({ feed: "trending" })).resolves.toMatchObject({
      items: [{ installRef: "@alice/weather", official: false }],
      nextCursor: "snapshot:next",
    });
    expectRoute(requestedUrls[2]!, "/api/v1/packages/weather", {
      family: "skill",
      ownerHandle: "alice",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      (input instanceof Request ? input.url : String(input)).includes("/api/v1/packages/weather")
        ? Response.json({ package: null })
        : fetchImpl(input),
    );
    await expect(fetchClawHubSkillCatalog({ feed: "trending" })).rejects.toThrow(
      "Malformed ClawHub skill listing",
    );
  });

  it.each([{ family: "code-plugin" }, { ownerHandle: "bob" }])(
    "does not borrow official status from mismatched trending metadata: %j",
    async (mismatch) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
      });
      const result = await fetchClawHubSkillCatalog({ feed: "trending" });
      expect(result.items).toMatchObject([{ installRef: "@alice/weather", official: undefined }]);
    },
  );

  it("rejects malformed catalog envelopes and unsupported search pagination", async () => {
    for (const response of [{}, { items: null }, { items: [null] }, { items: [], nextCursor: 1 }]) {
      jsonRequest(response);
      await expect(fetchClawHubSkillCatalog({})).rejects.toThrow("Malformed ClawHub");
    }
    await expect(fetchClawHubSkillCatalog({ query: "email", cursor: "next" })).rejects.toThrow(
      "does not support a cursor",
    );
    jsonRequest({});
    await expect(fetchClawHubSkillCatalog({ query: "email" })).rejects.toThrow("Malformed ClawHub");
  });

  it.each([
    ["   ", 0],
    ["false", 1],
  ] as const)(
    "applies primary telemetry setting %j before legacy opt-out",
    async (primary, calls) => {
      process.env.CLAWHUB_DISABLE_TELEMETRY = primary;
      process.env.CLAWDHUB_DISABLE_TELEMETRY = "true";
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

      await reportClawHubSkillInstallTelemetry({
        token: "test-token",
        slug: "calendar",
      });

      expect(fetchImpl).toHaveBeenCalledTimes(calls);
    },
  );

  it("sends canonical plugin install telemetry", async () => {
    const request = telemetryRequest();

    await reportClawHubPluginInstallTelemetry({
      token: "test-token",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
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
    });

    expect(request.body()).toMatchObject({
      event: "install",
      slug: "weather",
      version: "a".repeat(40),
      reference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
    });
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
      }),
    ).resolves.toMatchObject({
      skill: {
        slug: "weather",
        icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    });

    expectRoute(request.url(), "/api/v1/skills/weather", { ownerHandle: "demo-owner" });
  });

  it("sends skills-sh references to the ClawHub install resolver", async () => {
    const reference = "skills-sh:openclaw/skills/weather";
    const request = jsonRequest({ ok: true });

    await fetchClawHubSkillInstallResolution({
      slug: "weather",
      requestedReference: reference,
    });

    expectRoute(request.url(), "/api/v1/skills/weather/install", { reference });
  });

  it("sends owner-qualified skill verification lookups without resolved auth when requested", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    const request = jsonRequest({ schema: "clawhub.skill.verify.v1" });

    await expect(
      fetchClawHubSkillVerification({
        slug: "weather",
        ownerHandle: "demo-owner",
        version: "1.0.0",
        skipAuth: true,
      }),
    ).resolves.toMatchObject({ schema: "clawhub.skill.verify.v1" });

    expectRoute(request.url(), "/api/v1/skills/weather/verify", {
      ownerHandle: "demo-owner",
      version: "1.0.0",
    });
    expect(new Headers(request.init()?.headers).get("Authorization")).toBeNull();
  });

  it("posts bulk skill security verdict requests", async () => {
    const items = [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }];
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
        items,
      }),
    ).resolves.toEqual(envelope);

    const requestedInit = request.init();
    expect(request.url().pathname).toBe("/api/v1/skills/-/security-verdicts");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(requestedInit?.body).toBe(JSON.stringify({ items }));
  });

  it.each([
    {
      options: { slug: "agentreceipt", tag: "latest" },
      content: "# Agent Receipt\n\nVerified by ClawHub.\n",
      url: "https://clawhub.ai/api/v1/skills/agentreceipt/card?tag=latest",
    },
    {
      options: {
        url: "https://cards.example.test/generated/agentreceipt.md",
        baseUrl: "https://clawhub.ai",
      },
      content: "# Agent Receipt\n",
      url: "https://cards.example.test/generated/agentreceipt.md",
    },
  ])("fetches generated Skill Card markdown at $url", async ({ options, content, url }) => {
    const request = captureResponse(new Response(content));
    await expect(fetchClawHubSkillCard(options)).resolves.toBe(content);
    expect(request.url().href).toBe(url);
  });

  it.each([
    {
      content: "card missing",
      status: 404,
      error: "ClawHub /api/v1/skills/agentreceipt/card failed (404): card missing",
    },
    {
      content: "x".repeat(256 * 1024 + 1),
      status: 200,
      error: "ClawHub skill card for agentreceipt exceeded 262144 bytes (262145 bytes received)",
    },
  ])("rejects invalid generated Skill Card: $error", async ({ content, status, error }) => {
    captureResponse(new Response(content, { status }));
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
      }),
    ).rejects.toThrow(error);
  });
});

describe("clawhub packages", () => {
  const packageSelector = { name: "@openclaw/diagnostics-otel", version: "2026.3.22" };
  const versionPath = "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22";
  const securityReport = {
    package: { name: packageSelector.name, displayName: "Diagnostics", family: "code-plugin" },
    release: {
      releaseId: "rel_demo",
      version: packageSelector.version,
      artifactKind: "npm-pack",
      artifactSha256: "a".repeat(64),
      npmIntegrity: "sha512-proof",
      npmShasum: "abc",
    },
    overview: "The plugin uses privileged local APIs.\n\nReview those capabilities.",
    securityAuditUrl:
      "https://clawhub.ai/plugins/@openclaw/diagnostics-otel/security-audit?version=2026.3.22",
    trust: {
      scanStatus: "clean",
      moderationState: null,
      blockedFromDownload: false,
      reasons: [],
      pending: false,
      stale: true,
    },
  };

  afterEach(() => vi.restoreAllMocks());

  it("requests official search results before ClawHub applies the result cap", async () => {
    const { url } = jsonRequest({ results: [] });
    const query = { query: " research ", family: "claw", isOfficial: true, limit: 1 } as const;
    await expect(searchClawHubPackages(query)).resolves.toEqual([]);
    expect(url().pathname).toBe("/api/v1/packages/search");
    expect(Object.fromEntries(url().searchParams)).toEqual({
      q: "research",
      family: "claw",
      isOfficial: "true",
      limit: "1",
    });
  });

  it("resolves latest versions from latestVersion before tags", () => {
    const pkg = {
      name: "demo",
      displayName: "Demo",
      family: "code-plugin" as const,
      channel: "official" as const,
      isOfficial: true,
      createdAt: 0,
      updatedAt: 0,
      tags: { latest: "1.2.2" },
    };
    expect(resolveLatestVersionFromPackage({ package: { ...pkg, latestVersion: "1.2.3" } })).toBe(
      "1.2.3",
    );
    expect(resolveLatestVersionFromPackage({ package: pkg })).toBe("1.2.2");
  });

  it("fetches typed package artifact resolver reports", async () => {
    const report = {
      artifact: {
        source: "clawhub",
        artifactKind: "npm-pack",
        packageName: packageSelector.name,
        version: packageSelector.version,
        downloadUrl: "https://clawhub.ai/api/v1/clawpacks/abc",
        npmIntegrity: "sha512-demo",
        npmShasum: "abc",
      },
    };
    const { url } = jsonRequest(report);
    await expect(fetchClawHubPackageArtifact(packageSelector)).resolves.toEqual(report);
    expect(url().pathname).toBe(`${versionPath}/artifact`);
  });

  it("fetches typed package security reports", async () => {
    const { url } = jsonRequest(securityReport);
    const { releaseId, ...release } = securityReport.release;
    await expect(fetchClawHubPackageSecurity(packageSelector)).resolves.toEqual({
      ...securityReport,
      release: { ...release, id: releaseId },
    });
    expect(url().pathname).toBe(`${versionPath}/security`);
  });

  it.each([
    [
      { trust: { ...securityReport.trust, reasons: "clean", stale: false } },
      "reasons to be a string array",
    ],
    [
      {
        securityAuditUrl: securityReport.securityAuditUrl,
        trust: { blockedFromDownload: false, reasons: [], pending: false, stale: false },
      },
      "overview to be a non-empty string",
    ],
  ])("rejects malformed security report %j", async (report, error) => {
    jsonRequest(report);
    await expect(fetchClawHubPackageSecurity(packageSelector)).rejects.toThrow(`expected ${error}`);
  });
});
