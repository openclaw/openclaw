// Secret Scanning Remediation tests cover the approval-gated alert workflow helper.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRemediationPlan,
  redactLocationRange,
  redactLocationRanges,
  remediateAlert,
} from "../../scripts/github/secret-scanning-remediation.mjs";

type RequestRecord = { body?: string; method: string; url: string };

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

function testEnv() {
  return {
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_TOKEN: "test-token",
    OPENCLAW_SECRET_SCAN_API_BASE_URL: "https://api.test",
  };
}

function installFetch(routes: Record<string, (request: Request) => Response>) {
  const requests: RequestRecord[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init);
    requests.push({
      body: init?.body ? String(init.body) : undefined,
      method: request.method,
      url: request.url,
    });
    const parsed = new URL(request.url);
    const handler = routes[`${request.method} ${parsed.pathname}${parsed.search}`];
    if (!handler) {
      return jsonResponse(
        { message: `Unhandled ${request.method} ${parsed.pathname}` },
        { status: 404 },
      );
    }
    return handler(request);
  });
  return requests;
}

describe("secret scanning remediation script", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redacts the exact alert range without exposing the original secret", () => {
    const result = redactLocationRange(
      "key: abcdefghijklmnopqrstuvwxyz\n",
      {
        end_column: 32,
        end_line: 1,
        start_column: 6,
        start_line: 1,
      },
      "Example Token",
    );

    expect(result).toMatchObject({ changed: true });
    expect(result.text).toBe("key: [REDACTED Example Token]\n");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("applies multiple redactions against the original coordinates", () => {
    const result = redactLocationRanges(
      "tokens: alpha beta\n",
      [
        { end_column: 14, end_line: 1, start_column: 9, start_line: 1 },
        { end_column: 19, end_line: 1, start_column: 15, start_line: 1 },
      ],
      "Example Token",
    );

    expect(result).toMatchObject({ changed: true, ok: true });
    expect(result.text).toBe("tokens: [REDACTED Example Token] [REDACTED Example Token]\n");
    expect(result.text).not.toContain("alpha");
    expect(result.text).not.toContain("beta");
  });

  it("plans supported body remediation without changing GitHub content", async () => {
    const requests = installFetch({
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/7?hide_secret=true": () =>
        jsonResponse({
          number: 7,
          secret_type_display_name: "Discord Bot Token",
          state: "open",
        }),
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/7/locations?per_page=100": () =>
        jsonResponse([
          {
            details: {
              end_column: 15,
              end_line: 2,
              issue_url: "/repos/openclaw/openclaw/issues/55",
              start_column: 8,
              start_line: 2,
            },
            type: "issue_body",
          },
        ]),
      "GET /repos/openclaw/openclaw/issues/55": () =>
        jsonResponse({ number: 55, user: { login: "reporter" } }),
    });

    const plan = await buildRemediationPlan({ alertNumber: 7, env: testEnv() });

    expect(plan.action).toBe("approval-required");
    expect(plan.summary).toContain("issue_body:patch_body:author=@reporter");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("keeps commit alerts in manual handling instead of public notification", async () => {
    installFetch({
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/8?hide_secret=true": () =>
        jsonResponse({
          number: 8,
          secret_type_display_name: "Cloud Secret",
          state: "open",
        }),
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/8/locations?per_page=100": () =>
        jsonResponse([{ details: { path: "src/example.ts" }, type: "commit" }]),
    });

    const plan = await buildRemediationPlan({ alertNumber: 8, env: testEnv() });

    expect(plan).toMatchObject({
      action: "manual",
      reason: "unsupported_location",
    });
    expect(plan.summary).toContain("Manual remediation required");
  });

  it("patches body content and resolves the alert only during remediation", async () => {
    const requests = installFetch({
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/9?hide_secret=true": () =>
        jsonResponse({
          number: 9,
          secret_type_display_name: "Discord Bot Token",
          state: "open",
        }),
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/9/locations?per_page=100": () =>
        jsonResponse([
          {
            details: {
              end_column: 17,
              end_line: 1,
              issue_url: "/repos/openclaw/openclaw/issues/91",
              start_column: 8,
              start_line: 1,
            },
            type: "issue_body",
          },
        ]),
      "GET /repos/openclaw/openclaw/issues/91": () =>
        jsonResponse({ body: "token: plaintext\n", number: 91, user: { login: "reporter" } }),
      "PATCH /repos/openclaw/openclaw/issues/91": () => jsonResponse({ number: 91 }),
      "PATCH /repos/openclaw/openclaw/secret-scanning/alerts/9": () =>
        jsonResponse({ number: 9, state: "resolved" }),
    });

    const result = await remediateAlert({ alertNumber: 9, env: testEnv() });

    expect(result.skipped).toBe(false);
    const patchBody =
      requests.find((request) => request.method === "PATCH" && request.url.endsWith("/issues/91"))
        ?.body ?? "";
    expect(patchBody).toContain("[REDACTED Discord Bot Token]");
    expect(patchBody).not.toContain("plaintext");
    expect(requests.some((request) => request.url.endsWith("/issues/91/comments"))).toBe(false);
  });

  it("deletes and recreates issue comments once after applying all matching locations", async () => {
    const requests = installFetch({
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/10?hide_secret=true": () =>
        jsonResponse({
          number: 10,
          secret_type_display_name: "API Key",
          state: "open",
        }),
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/10/locations?per_page=100": () =>
        jsonResponse([
          {
            details: {
              end_column: 15,
              end_line: 1,
              issue_comment_url: "/repos/openclaw/openclaw/issues/comments/2001",
              start_column: 6,
              start_line: 1,
            },
            type: "issue_comment",
          },
          {
            details: {
              end_column: 24,
              end_line: 1,
              issue_comment_url: "/repos/openclaw/openclaw/issues/comments/2001",
              start_column: 16,
              start_line: 1,
            },
            type: "issue_comment",
          },
        ]),
      "GET /repos/openclaw/openclaw/issues/comments/2001": () =>
        jsonResponse({
          body: "key: secret123 other456\ncontext",
          html_url: "https://github.com/openclaw/openclaw/issues/77#issuecomment-2001",
          id: 2001,
          user: { login: "reporter" },
        }),
      "DELETE /repos/openclaw/openclaw/issues/comments/2001": () =>
        new Response(null, { status: 204 }),
      "POST /repos/openclaw/openclaw/issues/77/comments": () =>
        jsonResponse({
          html_url: "https://github.com/openclaw/openclaw/issues/77#issuecomment-3001",
        }),
      "PATCH /repos/openclaw/openclaw/secret-scanning/alerts/10": () =>
        jsonResponse({ number: 10, state: "resolved" }),
    });

    const result = await remediateAlert({ alertNumber: 10, env: testEnv() });

    expect(result.results).toMatchObject([
      { changed: true, locationType: "issue_comment", operation: "delete_recreate_comment" },
    ]);
    expect(
      requests.some(
        (request) => request.method === "PATCH" && request.url.includes("/comments/2001"),
      ),
    ).toBe(false);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    const replacement = requests.find((request) => request.method === "POST")?.body ?? "";
    expect(replacement).toContain("[REDACTED API Key]");
    expect(replacement).not.toContain("secret123");
    expect(replacement).not.toContain("other456");
  });

  it("does not resolve alerts when a supported location cannot be fully redacted", async () => {
    const requests = installFetch({
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/11?hide_secret=true": () =>
        jsonResponse({
          number: 11,
          secret_type_display_name: "API Key",
          state: "open",
        }),
      "GET /repos/openclaw/openclaw/secret-scanning/alerts/11/locations?per_page=100": () =>
        jsonResponse([
          {
            details: {
              end_column: 99,
              end_line: 1,
              issue_url: "/repos/openclaw/openclaw/issues/111",
              start_column: 80,
              start_line: 1,
            },
            type: "issue_body",
          },
        ]),
      "GET /repos/openclaw/openclaw/issues/111": () =>
        jsonResponse({ body: "key: short\n", number: 111, user: { login: "reporter" } }),
    });

    await expect(remediateAlert({ alertNumber: 11, env: testEnv() })).rejects.toThrow(
      /remediation incomplete/,
    );

    expect(
      requests.some((request) =>
        request.url.endsWith("/repos/openclaw/openclaw/secret-scanning/alerts/11"),
      ),
    ).toBe(false);
  });
});
