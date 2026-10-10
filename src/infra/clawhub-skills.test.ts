// Verifies ClawHub skill icons, telemetry, metadata, verification, and cards.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
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

function malformedUtf8(prefix: string, suffix: string): ArrayBuffer {
  const prefixBytes = new TextEncoder().encode(prefix);
  const suffixBytes = new TextEncoder().encode(suffix);
  const buffer = new ArrayBuffer(prefixBytes.byteLength + 1 + suffixBytes.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(prefixBytes);
  bytes[prefixBytes.byteLength] = 0xff;
  bytes.set(suffixBytes, prefixBytes.byteLength + 1);
  return buffer;
}

describe("clawhub skills", () => {
  afterEach(() => {
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_DISABLE_TELEMETRY;
    delete process.env.CLAWDHUB_DISABLE_TELEMETRY;
  });

  it("resolves hosted skill icons against the configured ClawHub origin", async () => {
    await expect(
      searchClawHubSkills({
        query: "playwright",
        baseUrl: "https://registry.example",
        fetchImpl: async () =>
          Response.json({
            results: [
              {
                score: 1,
                slug: "playwright-interactive",
                ownerHandle: "acme",
                displayName: "Playwright Interactive",
                source: "clawhub",
                install: { kind: "clawhub", reference: "acme/playwright-interactive" },
                icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
              },
            ],
          }),
      }),
    ).resolves.toMatchObject([
      {
        icon: `https://registry.example/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    ]);
  });

  it("rejects skill icons outside the configured hosted-icon route", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        results: [
          {
            score: 1,
            slug: "external",
            ownerHandle: "acme",
            displayName: "External",
            source: "clawhub",
            install: { kind: "clawhub", reference: "acme/external" },
            icon: `https://tracker.example/api/v1/skill-icons/${"a".repeat(64)}`,
          },
          {
            score: 1,
            slug: "wrong-path",
            ownerHandle: "acme",
            displayName: "Wrong Path",
            source: "clawhub",
            install: { kind: "clawhub", reference: "acme/wrong-path" },
            icon: "https://registry.example/icon.png",
          },
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
          {
            score: 2,
            slug: "email",
            ownerHandle: "alice",
            displayName: "Email",
            source: "clawhub",
            install: { kind: "clawhub", reference: "alice/email" },
          },
          {
            score: 1,
            slug: "email",
            ownerHandle: "bob",
            displayName: "Email",
            source: "clawhub",
            install: { kind: "clawhub", reference: "bob/email" },
          },
          {
            score: 1,
            slug: "weather",
            ownerHandle: "openclaw",
            displayName: "Weather",
            source: "skills-sh",
            install: { kind: "skills-sh", reference: "skills-sh:openclaw/skills/weather" },
          },
          {
            score: 1,
            slug: "github-backed",
            ownerHandle: "openclaw",
            displayName: "GitHub backed",
            source: "clawhub",
            install: { kind: "github", reference: "openclaw/github-backed" },
          },
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
          {
            score: 1,
            slug: "weather",
            ownerHandle: "acme",
            displayName: "Weather",
            source: "skills-sh",
            install: { kind: "skills-sh", reference: null },
          },
          // Native row without a publisher: every action on the bare slug answers 409.
          {
            score: 1,
            slug: "orphan",
            displayName: "Orphan",
            source: "clawhub",
            install: { kind: "clawhub", reference: "orphan" },
          },
          // Unknown source: nothing here says which artifact an install would resolve.
          {
            score: 1,
            slug: "mystery",
            ownerHandle: "acme",
            displayName: "Mystery",
            source: "future-registry",
            install: { kind: "future-registry", reference: "acme/mystery" },
          },
          // A known source still needs a supported delivery mechanism.
          {
            score: 1,
            slug: "future-install",
            ownerHandle: "acme",
            displayName: "Future install",
            source: "clawhub",
            install: { kind: "future-transport", reference: "acme/future-install" },
          },
          {
            score: 1,
            slug: "keep",
            ownerHandle: "acme",
            displayName: "Keep",
            source: "clawhub",
            install: { kind: "clawhub", reference: "acme/keep" },
          },
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
        items: [
          {
            slug: "weather",
            displayName: "Weather",
            source: "clawhub",
            official: true,
            publisher: { handle: "alice", official: true },
            install: { kind: "clawhub", reference: "alice/weather" },
            metrics: { updatedAt: 123 },
          },
        ],
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

  it.each([
    { family: "code-plugin" },
    { name: "another-skill" },
    { ownerHandle: "bob" },
    { ownerHandle: null },
  ])("does not borrow official status from mismatched trending metadata: %j", async (mismatch) => {
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
          items: [
            {
              slug: "weather",
              displayName: "Weather",
              source: "clawhub",
              official: true,
              publisher: { handle: "alice", official: true },
              install: { kind: "clawhub", reference: "alice/weather" },
              metrics: { updatedAt: 123 },
            },
          ],
        });
      },
    });
    expect(result.items).toMatchObject([{ installRef: "@alice/weather", official: undefined }]);
  });

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
    let requestBody: unknown;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected JSON request body");
      }
      requestBody = JSON.parse(init.body) as unknown;
      return new Response(null, { status: 200 });
    });

    await reportClawHubPluginInstallTelemetry({
      token: "test-token",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
      fetchImpl,
    });

    expect(requestBody).toEqual({
      event: "plugin_install",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
    });
  });

  it("applies the install telemetry opt-out to plugin reports", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubPluginInstallTelemetry({
      token: "test-token",
      packageName: "@openclaw/voice-call",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves skills-sh references in install telemetry", async () => {
    let body: unknown;

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "weather",
      version: "a".repeat(40),
      requestedReference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
      fetchImpl: async (_input, init) => {
        expect(typeof init?.body).toBe("string");
        body = JSON.parse(init?.body as string);
        return new Response(null, { status: 200 });
      },
    });

    expect(body).toMatchObject({
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
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillDetail({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: async (input) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          return Response.json({
            skill: {
              slug: "weather",
              displayName: "Weather",
              icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
              createdAt: 1,
              updatedAt: 2,
            },
          });
        },
      }),
    ).resolves.toMatchObject({
      skill: {
        slug: "weather",
        icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
  });

  it("sends owner-qualified skill install resolution lookups as slug plus ownerHandle", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillInstallResolution({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: async (input) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          return Response.json({
            ok: true,
            slug: "weather",
            installKind: "archive",
            archive: {
              version: "1.0.0",
              downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
            },
          });
        },
      }),
    ).resolves.toMatchObject({ ok: true, slug: "weather" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/install");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
  });

  it("sends skills-sh references to the ClawHub install resolver", async () => {
    let requestedUrl = "";
    const reference = "skills-sh:openclaw/skills/weather";

    await fetchClawHubSkillInstallResolution({
      slug: "weather",
      requestedReference: reference,
      fetchImpl: async (input) => {
        requestedUrl =
          input instanceof Request
            ? input.url
            : input instanceof Request
              ? input.url
              : String(input);
        return Response.json({
          ok: true,
          slug: "weather",
          installKind: "github",
          trust: { state: "not-scanned-by-clawhub" },
          github: {
            repo: "openclaw/skills",
            path: "skills/weather",
            commit: "a".repeat(40),
            contentHash: "sha256:approved",
            sourceUrl: "https://github.com/openclaw/skills",
          },
        });
      },
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/install");
    expect(url.searchParams.get("reference")).toBe(reference);
  });

  it("fetches skill verification reports and lets version take precedence over tag", async () => {
    let requestedUrl = "";
    const envelope = {
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt", displayName: "Agent Receipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.2.3", tag: "stable" },
      card: {
        available: true,
        url: "https://clawhub.ai/api/v1/skills/agentreceipt/card?version=1.2.3",
      },
      artifact: {
        sourceFingerprint: "source-fp",
        bundleFingerprints: ["generated-bundle-fp"],
      },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    };

    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        version: "1.2.3",
        tag: "stable",
        fetchImpl: async (input) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          return Response.json(envelope);
        },
      }),
    ).resolves.toEqual(envelope);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/agentreceipt/verify");
    expect(url.searchParams.get("version")).toBe("1.2.3");
    expect(url.searchParams.has("tag")).toBe(false);
  });

  it("sends owner-qualified skill verification lookups without resolved auth when requested", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;

    await expect(
      fetchClawHubSkillVerification({
        slug: "weather",
        ownerHandle: "demo-owner",
        version: "1.0.0",
        skipAuth: true,
        fetchImpl: async (input, init) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          requestedInit = init;
          return Response.json({
            schema: "clawhub.skill.verify.v1",
            ok: true,
            decision: "pass",
            reasons: [],
            skill: {},
            publisher: {},
            version: {},
            card: {},
            artifact: {},
            provenance: {},
            security: {},
            signature: {},
          });
        },
      }),
    ).resolves.toMatchObject({ schema: "clawhub.skill.verify.v1" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/verify");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
    expect(url.searchParams.get("version")).toBe("1.0.0");
    expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
  });

  it("posts bulk skill security verdict requests", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
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

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }],
        fetchImpl: async (input, init) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          requestedInit = init;
          return Response.json(envelope);
        },
      }),
    ).resolves.toEqual(envelope);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/-/security-verdicts");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(requestedInit?.body).toBe(
      JSON.stringify({
        items: [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }],
      }),
    );
  });

  it("can post bulk skill security verdict requests without resolved auth", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    let requestedInit: RequestInit | undefined;
    const envelope = {
      schema: "clawhub.skill.security-verdicts.v1",
      items: [],
    };

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", version: "1.2.3" }],
        skipAuth: true,
        fetchImpl: async (_input, init) => {
          requestedInit = init;
          return Response.json(envelope);
        },
      }),
    ).resolves.toEqual(envelope);

    expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
  });

  it("returns failed skill verification reports with missing card reasons", async () => {
    const envelope = {
      schema: "clawhub.skill.verify.v1",
      ok: false,
      decision: "fail",
      reasons: ["card.missing"],
      skill: { slug: "agentreceipt" },
      publisher: null,
      version: { version: "1.2.3" },
      card: { available: false },
      artifact: null,
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    };

    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        fetchImpl: async () => Response.json(envelope),
      }),
    ).resolves.toEqual(envelope);
  });

  it("fetches generated Skill Card markdown and applies tag queries", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        tag: "latest",
        fetchImpl: async (input) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          return new Response("# Agent Receipt\n\nVerified by ClawHub.\n", {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        },
      }),
    ).resolves.toBe("# Agent Receipt\n\nVerified by ClawHub.\n");

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/agentreceipt/card");
    expect(url.searchParams.get("tag")).toBe("latest");
    expect(url.searchParams.has("version")).toBe(false);
  });

  it("clamps oversized ClawHub request timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        fetchClawHubSkillCard({
          slug: "agentreceipt",
          timeoutMs: Number.MAX_SAFE_INTEGER,
          fetchImpl: async () =>
            new Response("# Agent Receipt\n", {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
            }),
        }),
      ).resolves.toBe("# Agent Receipt\n");

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("rejects malformed UTF-8 in generated Skill Card markdown", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response(malformedUtf8("# Agent ", "\n")),
      }),
    ).rejects.toThrow(TypeError);
  });

  it("fetches generated Skill Card markdown from an exact verified card URL", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillCard({
        url: "https://cards.example.test/generated/agentreceipt.md",
        baseUrl: "https://clawhub.ai",
        fetchImpl: async (input) => {
          requestedUrl =
            input instanceof Request
              ? input.url
              : input instanceof Request
                ? input.url
                : String(input);
          return new Response("# Agent Receipt\n", {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        },
      }),
    ).resolves.toBe("# Agent Receipt\n");

    expect(requestedUrl).toBe("https://cards.example.test/generated/agentreceipt.md");
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

  it("wraps non-200 skill verification responses", async () => {
    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("not found", { status: 404 }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/agentreceipt/verify failed (404): not found");
  });
});
