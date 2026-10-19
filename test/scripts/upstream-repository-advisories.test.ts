import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublishedRepositoryAdvisories } from "../../scripts/lib/upstream-repository-advisories.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";

const REGISTRY = "https://registry.npmjs.org";
const REPOSITORY = "fixture/packages";
const ADVISORY_ID = "GHSA-2222-3333-4444";
const NEXT_PAGE =
  '<https://api.github.com/repositories/42/security-advisories?state=published&per_page=100&after=next%2Bcursor>; rel="next"';

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const packageRepository: Handler = (url) =>
  manifest(url, `https://github.com/fixture/${url.pathname.split("/")[1]}`);
const packagePayload = Object.fromEntries(
  Array.from({ length: 8 }, (_, index) => [`package-${index}`, ["1.0.0"]]),
);
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function vulnerability(range: unknown, name: unknown = "fixture", ecosystem = "npm") {
  return { package: { ecosystem, name }, vulnerable_version_range: range };
}

const publishedRows = new Map<string, Record<string, unknown>>();

function advisory(range: unknown = "< 2.0.0", fields: Record<string, unknown> = {}) {
  const row = {
    ghsa_id: ADVISORY_ID,
    state: "published",
    withdrawn_at: null,
    severity: "high",
    summary: "Fixture vulnerability",
    vulnerabilities: [vulnerability(range)],
    ...fields,
  };
  if (!publishedRows.has(row.ghsa_id)) {
    publishedRows.set(row.ghsa_id, row);
  }
  return row;
}

function reviewedResponse(fields: Record<string, unknown> = {}) {
  return Response.json({
    ghsa_id: ADVISORY_ID,
    published_at: "2026-08-01T00:00:00Z",
    github_reviewed_at: "2026-08-02T00:00:00Z",
    withdrawn_at: null,
    ...fields,
  });
}

function manifest(url: URL, repository: unknown = `git+https://github.com/${REPOSITORY}.git`) {
  const [name, version] = url.pathname.slice(1).split("/").map(decodeURIComponent);
  return Response.json({ name, version, repository });
}

function createSourceFetch(
  handlers: {
    manifest?: Handler;
    repository?: Handler;
    page?: Handler;
    reviewed?: Handler;
    rows?: unknown[];
    row?: unknown;
  } = {},
) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.origin === REGISTRY) {
      return handlers.manifest ? handlers.manifest(url, init) : manifest(url);
    }
    if (url.origin !== "https://api.github.com") {
      throw new Error(`Unexpected request origin: ${url.origin}`);
    }
    if (url.pathname.startsWith("/advisories/")) {
      if (handlers.reviewed) {
        return handlers.reviewed(url, init);
      }
      const row = publishedRows.get(url.pathname.split("/").at(-1) ?? "");
      return reviewedResponse({ ...row, withdrawn_at: null });
    }
    if (url.pathname.endsWith("/security-advisories")) {
      return handlers.page
        ? handlers.page(url, init)
        : Response.json(handlers.rows ?? (handlers.row ? [handlers.row] : []));
    }
    return handlers.repository
      ? handlers.repository(url, init)
      : Response.json({ id: 42, full_name: REPOSITORY, private: false, visibility: "public" });
  };
  return { calls, fetchImpl };
}

function scan(fetchImpl: typeof fetch, payload: Record<string, string[]> = { fixture: ["1.0.0"] }) {
  return fetchPublishedRepositoryAdvisories({ payload, registryBaseUrl: REGISTRY, fetchImpl });
}

function expectPartialPage(report: Awaited<ReturnType<typeof scan>>) {
  expect(report.advisories).toHaveLength(1);
  expect(report.coverage).toMatchObject({ status: "partial", checkedRepositories: 0 });
}

function continuingPage(rows = [advisory()], link = NEXT_PAGE) {
  return Response.json(rows, { headers: { link } });
}

function afterFirstPage(handler: Handler): Handler {
  return (url, init) => (url.searchParams.has("after") ? handler(url, init) : continuingPage());
}

function scanSource(handlers: Parameters<typeof createSourceFetch>[0]) {
  return scan(createSourceFetch(handlers).fetchImpl);
}

function expectPartialIssues(report: Awaited<ReturnType<typeof scan>>, issues: unknown) {
  expect(report.coverage).toMatchObject({ status: "partial", issues });
}

function issue(reason: string, subject = REPOSITORY) {
  return { subject, reason };
}

beforeEach(() => {
  publishedRows.clear();
  vi.stubEnv("GH_TOKEN", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("published upstream repository advisories", () => {
  it("discovers exact scoped versions once and verifies a shared repository before scanning", async () => {
    const source = createSourceFetch({
      manifest: (url) =>
        manifest(
          url,
          url.pathname.includes("%2F")
            ? { url: "git+https://github.com/FIXTURE/packages.git", directory: "packages/leaf" }
            : "github:Fixture/Packages",
        ),
      row: advisory(">= 0", {
        vulnerabilities: [vulnerability(">= 0"), vulnerability("= 1.2.3", "@scope/leaf")],
      }),
    });
    const report = await scan(source.fetchImpl, {
      "@scope/leaf": ["1.2.3", "1.2.3"],
      fixture: ["1.0.0", "0.9.0"],
    });

    expect(source.calls.map(({ url }) => url.pathname)).toEqual([
      "/%40scope%2Fleaf/1.2.3",
      "/fixture/0.9.0",
      "/fixture/1.0.0",
      "/repos/fixture/packages",
      "/repos/fixture/packages/security-advisories",
      `/advisories/${ADVISORY_ID}`,
      `/advisories/${ADVISORY_ID}`,
    ]);
    expect(report.advisories).toMatchObject([
      { packageName: "@scope/leaf", matchedVersions: ["1.2.3"] },
      { packageName: "fixture", matchedVersions: ["0.9.0", "1.0.0"] },
    ]);
    expect(report.coverage).toMatchObject({
      status: "checked",
      packageVersions: 3,
      mappedPackageVersions: 3,
      repositories: 1,
      checkedRepositories: 1,
      issues: [],
    });
  });

  it("reconciles the published GHSA-8r6m-32jq-jx6q range without losing raw evidence", async () => {
    const name = "fast-xml-parser",
      id = "GHSA-8r6m-32jq-jx6q";
    const raw = ">= 5.9.3",
      reviewed = ">= 5.9.3, < 5.10.1";
    const source = createSourceFetch({
      row: advisory(raw, { ghsa_id: id, vulnerabilities: [vulnerability(raw, name)] }),
      reviewed: () =>
        reviewedResponse({
          ghsa_id: id,
          vulnerabilities: [vulnerability(reviewed, name)],
        }),
    });
    const report = await scan(source.fetchImpl, { [name]: ["5.11.0"] });
    expect(report.advisories).toEqual([]);
    expect(report.coverage).toMatchObject({
      status: "checked",
      reconciliations: [
        {
          id,
          packageName: name,
          repositoryRange: ">=5.9.3",
          reviewedRanges: [">=5.9.3 <5.10.1"],
          matchedVersions: [],
        },
      ],
    });
  });

  it.each([
    ["retains partial coverage when only patched versions are installed", ">=1.20.0", []],
    ["ignores ambiguous patch metadata", ">=1.20", ["1.20.0"]],
  ] satisfies [string, string, string[]][])("%s", async (_name, patched, matched) => {
    const source = createSourceFetch({
      row: advisory(">= 1.13.0", {
        vulnerabilities: [{ ...vulnerability(">= 1.13.0"), patched_versions: patched }],
      }),
      reviewed: () => new Response(null, { status: 404 }),
    });
    const report = await scan(source.fetchImpl, { fixture: ["1.20.0"] });
    expect(report.advisories.flatMap((entry) => entry.matchedVersions)).toEqual(matched);
    expectPartialIssues(report, [issue("request-failed", `fixture#${ADVISORY_ID}`)]);
  });

  it.each([
    { name: "wrong identity", response: { ghsa_id: "GHSA-5555-6666-7777" } },
    { name: "unreviewed", response: { github_reviewed_at: null } },
    { name: "wrong package", response: { vulnerabilities: [vulnerability("< 1.0.0", "another")] } },
  ])("retains the raw blocker when reviewed evidence is $name", async ({ response }) => {
    const report = await scanSource({
      row: advisory(),
      reviewed: () =>
        reviewedResponse({
          vulnerabilities: [vulnerability("< 1.0.0")],
          ...response,
        }),
    });
    expect(report.advisories).toMatchObject([{ id: ADVISORY_ID, matchedVersions: ["1.0.0"] }]);
    expectPartialIssues(
      report,
      expect.arrayContaining([expect.objectContaining({ subject: `fixture#${ADVISORY_ID}` })]),
    );
  });

  it("keeps resource denial by personal access token local while preserving real findings and reconciling stale ranges", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `GHSA-2222-3333-444${index}`);
    const inaccessible = ids.slice(0, 4);
    const trueMatch = expectDefined(ids[4], "true advisory");
    const staleMatch = expectDefined(ids[5], "stale advisory");
    const secret = "synthetic-advisory-secret";
    vi.stubEnv("GH_TOKEN", secret);
    const source = createSourceFetch({
      rows: ids.map((id) => advisory("< 2.0.0", { ghsa_id: id })),
      reviewed: (url) => {
        const id = url.pathname.split("/").at(-1) ?? "";
        if (inaccessible.includes(id)) {
          return Response.json(
            { message: "Resource not accessible by personal access token", diagnostic: secret },
            { status: 403, headers: { "x-ratelimit-remaining": "100" } },
          );
        }
        return reviewedResponse({
          ghsa_id: id,
          vulnerabilities: [vulnerability(id === staleMatch ? "< 1.0.0" : "< 2.0.0")],
        });
      },
    });
    const report = await scan(source.fetchImpl);
    expect(report.advisories.map(({ id }) => id)).toEqual([...inaccessible, trueMatch]);
    expect(report.coverage.issues).toEqual(
      inaccessible.map((id) => issue("request-failed", `fixture#${id}`)),
    );
    expect(report.coverage.reconciliations).toMatchObject([
      { id: trueMatch, matchedVersions: ["1.0.0"] },
      { id: staleMatch, matchedVersions: [] },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("sends the token only to fixed GitHub requests and refuses redirects on every request", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-upstream-test-token");
    const source = createSourceFetch();
    await scan(source.fetchImpl);

    expect(source.calls).toHaveLength(3);
    for (const { url, init } of source.calls) {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBe(
        url.origin === REGISTRY ? null : "Bearer synthetic-upstream-test-token",
      );
      if (url.origin !== REGISTRY) {
        expect(url.origin).toBe("https://api.github.com");
      }
    }
  });

  it("does not attach the GitHub token to a registry lookup even when its origin is GitHub", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-upstream-test-token");
    const headers: Headers[] = [];
    const report = await fetchPublishedRepositoryAdvisories({
      payload: { fixture: ["1.0.0"] },
      registryBaseUrl: "https://api.github.com",
      fetchImpl: async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return Response.json({ name: "fixture", version: "1.0.0" });
      },
    });
    expect(headers).toHaveLength(1);
    expect(expectDefined(headers[0], "registry request headers").has("authorization")).toBe(false);
    expect(report.coverage.status).toBe("partial");
  });

  it("records unsupported locked versions without requesting registry metadata", async () => {
    const source = createSourceFetch();
    const report = await scan(source.fetchImpl, { fixture: ["git+https://example.invalid/pkg"] });
    expect(source.calls).toEqual([]);
    expectPartialIssues(report, [
      issue("unsupported-version", "fixture@git+https://example.invalid/pkg"),
    ]);
  });

  it.each([
    ["latest instead of locked version", { name: "fixture", version: "2.0.0" }, "invalid-response"],
    ["missing repository", { name: "fixture", version: "1.0.0" }, "unsupported-repository"],
    [
      "userinfo host confusion",
      "https://github.com@evil.example/fixture/packages",
      "unsupported-repository",
    ],
    [
      "credential-bearing URL",
      "https://user:password@github.com/fixture/packages",
      "unsupported-repository",
    ],
    ["branch URL", "https://github.com/fixture/packages/tree/main", "unsupported-repository"],
  ] satisfies [string, string | { name: string; version: string }, string][])(
    "does not scan %s registry metadata",
    async (_name, data, reason) => {
      const source = createSourceFetch({
        manifest: (url) => (typeof data === "string" ? manifest(url, data) : Response.json(data)),
      });
      const report = await scan(source.fetchImpl);
      expect(source.calls).toHaveLength(1);
      expect(report.advisories).toEqual([]);
      expect(report.coverage).toMatchObject({
        status: "partial",
        mappedPackageVersions: 0,
        issues: [issue(reason, "fixture@1.0.0")],
      });
    },
  );

  it.each([
    { name: "private", data: { id: 42, private: true }, reason: "repository-not-public" },
    { name: "invalid ID", data: { id: "42", private: false }, reason: "invalid-response" },
  ])("does not request advisories from $name repository metadata", async ({ data, reason }) => {
    const source = createSourceFetch({ repository: () => Response.json(data) });
    const report = await scan(source.fetchImpl);
    expect(source.calls.map(({ url }) => url.pathname)).toEqual([
      "/fixture/1.0.0",
      "/repos/fixture/packages",
    ]);
    expect(report.coverage).toMatchObject({
      status: "partial",
      checkedRepositories: 0,
      issues: [issue(reason)],
    });
  });

  it("matches only the declared npm package, ignores withdrawn entries, and normalizes medium severity", async () => {
    const report = await scanSource({
      rows: [
        advisory("< 2.0.0", {
          severity: "medium",
          vulnerabilities: [
            vulnerability("< 2.0.0"),
            vulnerability("< 2.0.0", "Fixture"),
            vulnerability("< 2.0.0", "fixture", "pip"),
            vulnerability("< 2.0.0", "other"),
          ],
        }),
        advisory("< 2.0.0", { withdrawn_at: "2026-01-01T00:00:00Z" }),
      ],
    });
    expect(report.advisories).toMatchObject([
      {
        packageName: "fixture",
        severity: "moderate",
        matchedVersions: ["1.0.0"],
        url: `https://github.com/${REPOSITORY}/security/advisories/${ADVISORY_ID}`,
      },
    ]);
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage.status).toBe("checked");
  });

  it.each([
    { name: "unpublished", fields: { state: "draft" } },
    { name: "unknown severity", fields: { severity: null } },
    {
      name: "missing npm package identity",
      fields: { vulnerabilities: [vulnerability("< 2.0.0", null)] },
    },
  ])("reports $name advisory evidence as incomplete rather than unaffected", async ({ fields }) => {
    const report = await scanSource({ row: advisory("< 2.0.0", fields) });
    expect(report.advisories).toEqual([]);
    expectPartialIssues(
      report,
      expect.arrayContaining([expect.objectContaining({ reason: "invalid-advisory" })]),
    );
  });

  it.each([null, ">= 1.0", "< 2.0.0, > 1.0.0"])("keeps match beside invalid %s", async (range) => {
    const report = await scanSource({
      row: advisory("< 2.0.0", {
        vulnerabilities: [vulnerability("< 2.0.0"), vulnerability(range)],
      }),
    });
    expect(report.advisories).toMatchObject([{ id: ADVISORY_ID, matchedVersions: ["1.0.0"] }]);
    expectPartialIssues(
      report,
      expect.arrayContaining([issue("invalid-range", `fixture#${ADVISORY_ID}`)]),
    );
  });

  it.each([
    "https://evil.example/repositories/42/security-advisories?after=next",
    "https://api.github.com/repositories/999/security-advisories?state=published&after=next",
    "https://api.github.com/repositories/42/security-advisories?state=draft&after=next",
    "https://user:password@api.github.com/repositories/42/security-advisories?state=published&after=next",
  ])("does not continue an untrusted pagination link (%s)", async (next) => {
    const source = createSourceFetch({
      page: (url) =>
        url.searchParams.has("after")
          ? Response.json([])
          : continuingPage([advisory()], `<${next}>; rel="next"`),
    });
    const report = await scan(source.fetchImpl);
    expect(
      source.calls.filter(({ url }) => url.pathname.endsWith("/security-advisories")),
    ).toHaveLength(1);
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage).toMatchObject({
      status: "partial",
      checkedRepositories: 0,
      issues: [issue("invalid-pagination")],
    });
  });

  it("preserves earlier findings when a later page is oversized", async () => {
    const report = await scanSource({
      page: afterFirstPage(() => Response.json(Array.from({ length: 101 }, () => advisory()))),
    });
    expectPartialPage(report);
    expect(report.coverage.issues).toHaveLength(1);
  });

  it.each(["repeated cursor", "page budget"])("retains findings at %s", async (limit) => {
    let pages = 0;
    const source = createSourceFetch({
      page: () => {
        pages += 1;
        const cursor = limit === "repeated cursor" ? "same" : String(pages);
        return Response.json(pages === 1 ? [advisory()] : [], {
          headers: {
            link: `<https://api.github.com/repositories/42/security-advisories?state=published&after=${cursor}>; rel="next"`,
          },
        });
      },
    });
    const report = await scan(source.fetchImpl);
    expect(pages).toBe(limit === "repeated cursor" ? 2 : 5);
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage).toMatchObject({
      status: "partial",
      checkedRepositories: 0,
      issues: [issue(limit === "repeated cursor" ? "invalid-pagination" : "budget-exhausted")],
    });
  });

  it("cancels an oversized streamed page and retains earlier findings", async () => {
    const cancel = vi.fn();
    const report = await scanSource({
      page: afterFirstPage(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
              },
              cancel,
            }),
          ),
      ),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expectPartialPage(report);
  });

  it.each(["request", "run"])("settles at %s deadline, retaining findings", async (deadline) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const realSetTimeout = globalThis.setTimeout;
    // Exercise the real timeout race without a 15-second wait or shared fake timers.
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) => {
      return realSetTimeout(callback, milliseconds === 15_000 ? 1 : milliseconds, ...args);
    });
    const cancel = vi.fn();
    const source = createSourceFetch({
      page: (url) => {
        if (!url.searchParams.has("after")) {
          if (deadline === "run") {
            now = 5 * 60_000 - 5;
          }
          return continuingPage();
        }
        if (deadline === "request") {
          // A transport that ignores AbortSignal must not prevent the report from settling.
          return new Promise<Response>(() => {});
        }
        now = 5 * 60_000;
        return new Response(new ReadableStream<Uint8Array>({ cancel }));
      },
    });
    const report = await scan(source.fetchImpl);
    const stalledSignal = expectDefined(
      source.calls.find(({ url }) => url.searchParams.has("after"))?.init?.signal,
      "stalled advisory request signal",
    );
    expect(stalledSignal.aborted).toBe(true);
    expect(stalledSignal.reason).toMatchObject({
      message: `Upstream advisory request exceeded timeout of ${deadline === "run" ? 5 : 15_000}ms`,
    });
    expect(cancel).toHaveBeenCalledTimes(deadline === "run" ? 1 : 0);
    expectPartialPage(report);
    expect(report.coverage.issues).toContainEqual(
      issue(deadline === "run" ? "budget-exhausted" : "request-failed"),
    );
  });

  it("reconciles discovered findings before exhausting the bounded discovery budget", async () => {
    const versions = Array.from({ length: 2501 }, (_, index) => `1.0.${index}`);
    const affectedId = "GHSA-5555-6666-7777";
    const reviewStarted = createDeferred();
    const releaseReview = createDeferred();
    const discoveryBudgetFilled = createDeferred();
    const source = createSourceFetch({
      manifest: (url) =>
        manifest(url, `https://github.com/fixture/package-${url.pathname.split("/").at(-1)}`),
      page: (url) =>
        Response.json(
          url.pathname === "/repos/fixture/package-1.0.0/security-advisories"
            ? [advisory(), advisory("< 2.0.0", { ghsa_id: affectedId })]
            : [],
        ),
      reviewed: async (url) => {
        if (url.pathname.endsWith(ADVISORY_ID)) {
          reviewStarted.resolve();
          await releaseReview.promise;
        }
        return reviewedResponse({
          ghsa_id: url.pathname.split("/").at(-1),
          vulnerabilities: [
            vulnerability(url.pathname.endsWith(affectedId) ? "< 1.0.1" : "< 1.0.0"),
          ],
        });
      },
    });
    const scanning = scan(
      async (input, init) => {
        const response = await source.fetchImpl(input, init);
        if (source.calls.length >= 3999) {
          discoveryBudgetFilled.resolve();
        }
        return response;
      },
      { fixture: versions },
    );
    try {
      await withTestTimeout(
        Promise.all([reviewStarted.promise, discoveryBudgetFilled.promise]),
        1_000,
        "expected discovery to reach the reserved reconciliation capacity",
      );
      await nextTurn();
      expect(source.calls).toHaveLength(3999);
    } finally {
      releaseReview.resolve();
      await scanning;
    }
    const report = await scanning;
    expect(source.calls.filter(({ url }) => url.origin === REGISTRY)).toHaveLength(2500);
    expect(source.calls).toHaveLength(4000);
    expect(report.coverage).toMatchObject({
      status: "partial",
      packageVersions: 2501,
      mappedPackageVersions: 2500,
      reconciliations: [
        { id: ADVISORY_ID, matchedVersions: [] },
        { id: affectedId, matchedVersions: ["1.0.0"] },
      ],
    });
    expect(report.advisories).toMatchObject([{ id: affectedId, matchedVersions: ["1.0.0"] }]);
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage.issues).toContainEqual(
      issue("budget-exhausted", "1 package versions not inspected"),
    );
    expect(
      report.coverage.issues.some(
        ({ subject, reason }) =>
          subject.startsWith("fixture/package-") && reason === "budget-exhausted",
      ),
    ).toBe(true);
  });

  it("keeps metadata and repository requests within four concurrent operations", async () => {
    let active = 0;
    let peak = 0;
    const waves = [REGISTRY, "https://api.github.com"].map((origin) => ({
      origin,
      started: createDeferred(),
      release: createDeferred(),
    }));
    const source = createSourceFetch({
      manifest: packageRepository,
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const wave = expectDefined(
        waves.find(({ origin }) => origin === url.origin),
        "request phase",
      );
      active += 1;
      peak = Math.max(peak, active);
      if (active === 4) {
        wave.started.resolve();
      }
      try {
        await wave.release.promise;
        return await source.fetchImpl(input, init);
      } finally {
        active -= 1;
      }
    };
    const scanning = scan(fetchImpl, packagePayload);
    try {
      for (const wave of waves) {
        await withTestTimeout(
          wave.started.promise,
          1_000,
          `expected four requests to ${wave.origin}`,
        );
        // Let admission finish while requests stay blocked so excess fanout is observable.
        await nextTurn();
        expect(active).toBe(4);
        wave.release.resolve();
      }
      const report = await scanning;
      expect(peak).toBe(4);
      expect(active).toBe(0);
      expect(report.coverage).toMatchObject({ status: "checked", checkedRepositories: 8 });
    } finally {
      for (const wave of waves) {
        wave.release.resolve();
      }
      await scanning;
    }
  });

  it.each([
    ["100", "request-failed", null],
    [
      "100",
      "request-failed",
      JSON.stringify({
        message: "Resource not accessible by integration",
        padding: "x".repeat(2 * 1024 * 1024),
      }),
    ],
    ["0", "rate-limited", JSON.stringify({ message: "Resource not accessible by integration" })],
  ] satisfies [string, string, string | null][])(
    "stops scheduling after HTTP 403 (remaining %s)",
    async (remaining, expectedReason, body) => {
      const source = createSourceFetch({
        manifest: packageRepository,
        page: () =>
          new Response(body, {
            status: 403,
            headers: { "x-ratelimit-remaining": remaining },
          }),
      });
      const report = await scan(source.fetchImpl, packagePayload);
      expect(source.calls.filter(({ url }) => url.origin === REGISTRY)).toHaveLength(8);
      expect(
        source.calls.some(({ url }) =>
          /\/repos\/fixture\/package-[4-7](?:\/|$)/u.test(url.pathname),
        ),
      ).toBe(false);
      expect(report.coverage.status).toBe("partial");
      expect(report.coverage.issues.some(({ reason }) => reason === expectedReason)).toBe(true);
      expect(JSON.stringify(report)).not.toContain("synthetic-advisory-secret");
    },
  );
});
