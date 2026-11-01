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

function catalogListing(
  packageValue: unknown = listing,
  nextCursor: string | null = "snapshot:next",
) {
  const urls: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    return Response.json(
      url.pathname === "/api/v1/packages/search"
        ? { results: [{ score: 9, package: packageValue }] }
        : url.pathname === "/api/v1/packages/weather"
          ? { package: packageValue }
          : { items: [trendingWeather], ...(nextCursor ? { nextCursor } : {}) },
    );
  });
  return urls;
}

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
      results.map(({ installRef, installOnly, trustState }) => [
        installRef,
        installOnly,
        trustState,
      ]),
    ).toEqual([
      ["@alice/email", undefined, undefined],
      ["@bob/email", undefined, undefined],
      ["skills-sh:openclaw/skills/weather", true, "not-scanned-by-clawhub"],
      ["@openclaw/github-backed", undefined, undefined],
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
      items: [true, false, undefined].map((isOfficial, index) =>
        Object.assign({}, listing, {
          name: "email",
          ownerHandle: ["alice", "bob", "charlie"][index],
          isOfficial,
          latestVersion: index === 0 ? "1.2.3" : null,
        }),
      ),
      nextCursor: "skillcat:following",
    });
    const result = await catalog({ cursor: "skillcat:next", officialOnly: true, limit: 25 });

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
    const result = await catalog({ feed: "trending", cursor: "snapshot:next" });
    expectRoute(request.url(), "/api/v1/trending", {
      kind: "skills",
      limit: "100",
      cursor: "snapshot:next",
    });
    expect(result.items).toMatchObject([
      {
        installRef: "skills-sh:alice/skills/email",
        installOnly: true,
        trustState: "not-scanned-by-clawhub",
        updatedAt: 456,
      },
    ]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("searches listing metadata and resolves trending publisher badges to the listing flag", async () => {
    const requestedUrls = catalogListing();
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
    catalogListing(null);
    await expect(fetchClawHubSkillCatalog({ feed: "trending" })).rejects.toThrow(
      "Malformed ClawHub skill listing",
    );
  });

  it.each([{ family: "code-plugin" }, { ownerHandle: "bob" }])(
    "does not borrow official status from mismatched trending metadata: %j",
    async (mismatch) => {
      catalogListing({ ...listing, isOfficial: true, ...mismatch }, null);
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
      const { fetch } = telemetryRequest();
      await reportClawHubSkillInstallTelemetry({ token: "test-token", slug: "calendar" });
      expect(fetch).toHaveBeenCalledTimes(calls);
    },
  );

  it("sends canonical plugin install telemetry", async () => {
    const request = telemetryRequest();

    const plugin = { packageName: "@openclaw/voice-call", version: "2026.7.23" };
    await reportClawHubPluginInstallTelemetry({ token: "test-token", ...plugin });
    expect(request.body()).toEqual({ event: "plugin_install", ...plugin });
  });

  it("preserves skills-sh references in install telemetry", async () => {
    const request = telemetryRequest();

    const skill = {
      slug: "weather",
      version: "a".repeat(40),
      trustState: "not-scanned-by-clawhub" as const,
    };
    const reference = "skills-sh:openclaw/skills/weather";
    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      ...skill,
      requestedReference: reference,
    });
    expect(request.body()).toMatchObject({
      event: "install",
      ...skill,
      reference,
    });
  });

  it("sends owner-qualified skill detail lookups as slug plus ownerHandle", async () => {
    const icon = `/api/v1/skill-icons/${"a".repeat(64)}`;
    const request = jsonRequest({ skill: { slug: "weather", icon } });
    await expect(
      fetchClawHubSkillDetail({ slug: "weather", ownerHandle: "demo-owner" }),
    ).resolves.toMatchObject({
      skill: { slug: "weather", icon: `https://clawhub.ai${icon}` },
    });

    expectRoute(request.url(), "/api/v1/skills/weather", { ownerHandle: "demo-owner" });
  });

  it("sends skills-sh references to the ClawHub install resolver", async () => {
    const reference = "skills-sh:openclaw/skills/weather";
    const request = jsonRequest({ ok: true });

    await fetchClawHubSkillInstallResolution({ slug: "weather", requestedReference: reference });

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
    const envelope = { schema: "clawhub.skill.security-verdicts.v1", items: [] };
    const request = jsonRequest(envelope);

    await expect(fetchClawHubSkillSecurityVerdicts({ items })).resolves.toEqual(envelope);

    const requestedInit = request.init();
    expect(request.url().pathname).toBe("/api/v1/skills/-/security-verdicts");
    expect(requestedInit).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  });

  it.each([
    [
      { slug: "agentreceipt", tag: "latest" },
      "https://clawhub.ai/api/v1/skills/agentreceipt/card?tag=latest",
    ],
    [
      { url: "https://cards.example.test/card.md", baseUrl: "https://clawhub.ai" },
      "https://cards.example.test/card.md",
    ],
  ] as const)("fetches generated Skill Card markdown: %j", async (options, url) => {
    const content = "# Agent Receipt\n";
    const request = captureResponse(new Response(content));
    await expect(fetchClawHubSkillCard(options)).resolves.toBe(content);
    expect(request.url().href).toBe(url);
  });

  it.each([
    ["card missing", 404, "failed (404): card missing"],
    ["x".repeat(256 * 1024 + 1), 200, "exceeded 262144 bytes (262145 bytes received)"],
  ] as const)("rejects invalid generated Skill Card (%s, %s)", async (content, status, error) => {
    captureResponse(new Response(content, { status }));
    await expect(fetchClawHubSkillCard({ slug: "agentreceipt" })).rejects.toThrow(error);
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
    overview: "Review privileged local APIs.",
    securityAuditUrl: "https://clawhub.ai/audit",
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
    const query = { query: " research ", family: "template", isOfficial: true, limit: 1 } as const;
    await expect(searchClawHubPackages(query)).resolves.toEqual([]);
    expect(url().pathname).toBe("/api/v1/packages/search");
    expect(Object.fromEntries(url().searchParams)).toEqual({
      q: "research",
      family: "template",
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

  it("fetches package artifact resolver reports", async () => {
    const report = { artifact: { source: "clawhub", downloadUrl: "https://clawhub.ai/artifact" } };
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
