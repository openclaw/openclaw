import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  ControlUiGitHubError,
  fetchGitHubApi,
  fetchGitHubJson,
  formatControlUiGitHubPreviewError,
  readGitHubGraphQLResponse,
  readGitHubJsonResponse,
} from "./control-ui-github-api.js";

describe("Control UI GitHub failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["before admission", "during credential revalidation"])(
    "does not dispatch a caller cancelled %s",
    async (phase) => {
      const controller = new AbortController();
      const cancelled = new Error("Caller cancelled repository preparation");
      const identity = {
        revalidate: vi.fn(async () => controller.abort(cancelled)),
        assertSelected: vi.fn(),
      };
      const fetchImpl = vi.fn<typeof fetch>();
      if (phase === "before admission") {
        controller.abort(cancelled);
      }
      await expect(
        fetchGitHubApi(
          "https://api.github.com/repos/owner/repo",
          fetchImpl,
          undefined,
          undefined,
          identity,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(cancelled);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(identity.revalidate).toHaveBeenCalledTimes(phase === "before admission" ? 0 : 1);
    },
  );

  it("joins caller cancellation to the existing HTTP deadline", async () => {
    const started = createDeferred<AbortSignal>();
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("HTTP request has no signal");
      }
      started.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Request aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const request = fetchGitHubApi(
      "https://api.github.com/repos/owner/repo",
      fetchImpl,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    const signal = await started.promise;
    expect(signal).not.toBe(controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ statusCode: 502 });
    expect(signal.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps the default JSON byte cap when a caller supplies a larger metadata budget", async () => {
    const body = JSON.stringify({ summary: "x".repeat(256 * 1024) });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
    const url = "https://api.github.com/repos/owner/repo";

    await expect(fetchGitHubJson(url, fetchImpl)).rejects.toMatchObject({
      statusCode: 502,
      message: "GitHub response exceeded the size limit",
    });
    await expect(fetchGitHubJson(url, fetchImpl, undefined, 512 * 1024)).resolves.toBeTypeOf(
      "object",
    );
    await expect(fetchGitHubJson(url, fetchImpl)).rejects.toMatchObject({ statusCode: 502 });
  });

  it.each([
    {
      resource: "core",
      limited: "/user/1",
      sibling: "/repos/owner/repo",
      independent: "/search/repositories",
    },
    {
      resource: "search",
      limited: "/search/repositories",
      sibling: "/search/issues",
      independent: "/user/1",
    },
    {
      resource: "code_search",
      limited: "/search/code?q=first",
      sibling: "/search/code?q=second",
      independent: "/search/repositories",
    },
    ...[403, 200].map((status) => ({
      resource: "graphql",
      limited: "/graphql",
      sibling: "/graphql",
      independent: "/repos/owner/repo",
      status,
    })),
  ])(
    "shares $resource quota cooldown without blocking other buckets or credentials",
    async ({ resource, limited, sibling, independent, ...options }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), {
            status: "status" in options ? options.status : 403,
            headers: {
              "x-ratelimit-resource": resource,
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1800000090",
            },
          }),
        )
        .mockImplementation(async () => new Response("{}"));
      const request = async (path: string, token = "quota-token") => {
        const response = await fetchGitHubApi(
          `https://api.github.com${path}`,
          fetchMock,
          token,
          undefined,
          undefined,
          undefined,
          undefined,
          path === "/graphql" ? { query: "query { viewer { login } }", variables: {} } : undefined,
        );
        return path === "/graphql"
          ? readGitHubGraphQLResponse(response, fetchMock, token)
          : readGitHubJsonResponse(response);
      };
      await expect(request(limited)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 90_000,
      });
      clock.mockReturnValue(1_800_000_010_000);
      await expect(request(sibling)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 80_000,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      await expect(request(independent)).resolves.toEqual({});
      await expect(request(sibling, "rotated-token")).resolves.toEqual({});
      clock.mockReturnValue(1_800_000_090_000);
      await expect(request(sibling)).resolves.toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );

  it.each<{ headers: Record<string, string>; delay: number }>([
    { headers: { "retry-after": "90" }, delay: 90_000 },
    { headers: {}, delay: 60_000 },
    { headers: { "retry-after": "invalid", "x-ratelimit-reset": "Infinity" }, delay: 60_000 },
    {
      headers: { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1800000010" },
      delay: 60_000,
    },
    {
      headers: { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1800003000" },
      delay: 60_000,
    },
  ])(
    "shares secondary quota cooldown across REST buckets: $delay ms",
    async ({ headers, delay }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(null, { status: 429, headers }));
      await expect(
        fetchGitHubJson("https://api.github.com/search/repositories", fetchMock),
      ).rejects.toMatchObject({ statusCode: 429, retryAfterMs: delay });
      await expect(
        fetchGitHubJson("https://api.github.com/user/1", fetchMock),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(fetchMock).toHaveBeenCalledOnce();
      await expect(
        fetchGitHubApi("https://api.github.com/graphql", fetchMock, undefined),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(fetchMock).toHaveBeenCalledOnce();
      clock.mockReturnValue(1_800_000_000_000 + delay);
      await expect(
        fetchGitHubJson("https://api.github.com/user/1", fetchMock),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, "42"])(
    "retains a GraphQL HTTP 403 quota error with remaining=%s across REST reads",
    async (remaining) => {
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "private-diagnostic" }] }),
            { status: 403, headers: remaining ? { "x-ratelimit-remaining": remaining } : {} },
          ),
      );
      const response = await fetchGitHubApi(
        "https://api.github.com/graphql",
        fetchMock,
        "quota-token",
        undefined,
        undefined,
        undefined,
        undefined,
        { query: "query { viewer { login } }", variables: {} },
      );
      await expect(
        readGitHubGraphQLResponse(response, fetchMock, "quota-token"),
      ).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 60_000,
      });
      await expect(
        fetchGitHubApi("https://api.github.com/repos/owner/repo", fetchMock, "quota-token"),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [60, 120],
    [120, 60],
  ])(
    "reports the first recovering credential when reset times are %j",
    async (authSeconds, anonymousSeconds) => {
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(
        async (_url, init) =>
          new Response(null, {
            status: 403,
            headers: {
              "x-ratelimit-resource": "core",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(
                1_800_000_000 +
                  (new Headers(init?.headers).has("Authorization")
                    ? authSeconds
                    : anonymousSeconds),
              ),
            },
          }),
      );
      await expect(
        fetchGitHubJson("https://api.github.com/user/1", fetchMock, "quota-token"),
      ).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 60_000 });
      await expect(
        fetchGitHubJson("https://api.github.com/repos/owner/repo", fetchMock, "quota-token"),
      ).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 60_000 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("retains the longest concurrent cooldown and rechecks live identity before rejecting", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const firstResponse = createDeferred<Response>();
    const secondResponse = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => firstResponse.promise)
      .mockImplementationOnce(async () => secondResponse.promise);
    const request = () =>
      fetchGitHubJson("https://api.github.com/user/1", fetchMock).catch((error: unknown) => error);
    const first = request();
    const second = request();
    firstResponse.resolve(new Response(null, { status: 429, headers: { "retry-after": "90" } }));
    await expect(first).resolves.toMatchObject({ retryAfterMs: 90_000 });
    secondResponse.resolve(new Response(null, { status: 429, headers: { "retry-after": "30" } }));
    await expect(second).resolves.toMatchObject({ retryAfterMs: 90_000 });
    const retired = new Error("identity retired");
    const identity = {
      revalidate: vi.fn(async () => {
        throw retired;
      }),
      assertSelected: vi.fn(),
    };
    await expect(
      fetchGitHubApi("https://api.github.com/user/1", fetchMock, undefined, undefined, identity),
    ).rejects.toBe(retired);
    expect(identity.revalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each<{ status: number; headers: Record<string, string>; delay: number }>([
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788393720" },
      delay: 120_000,
    },
    { status: 429, headers: { "retry-after": "90" }, delay: 90_000 },
    {
      status: 403,
      headers: {
        "retry-after": "Thu, 03 Sep 2026 00:02:00 GMT",
        "x-ratelimit-reset": "1788393900",
      },
      delay: 120_000,
    },
  ])(
    "preserves rate-limit status and retry timing for HTTP $status",
    async ({ status, headers, delay }) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-03T00:00:00Z"));
      const error = await readGitHubJsonResponse(
        new Response('{"message":"secret-upstream-body"}', { status, headers }),
      ).catch((failure: unknown) => failure);

      expect(error).toMatchObject({ statusCode: 429, retryAfterMs: delay });
      const display = formatControlUiGitHubPreviewError(error);
      expect(display).toMatchObject({ retryable: true, retryAfterMs: delay });
      expect(display.message).toContain(`HTTP ${status}`);
      expect(display.message).toMatch(/rate limit/i);
      expect(display.message).not.toContain("secret-upstream-body");
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-03T00:00:30Z"));
      expect(formatControlUiGitHubPreviewError(error).retryAfterMs).toBe(delay - 30_000);
    },
  );

  it.each([
    { status: 401, reason: /authentication/i, action: /Settings/ },
    { status: 403, reason: /access denied/i, action: /repository access/i },
    { status: 404, reason: /unavailable or not public/i, action: /open the link/i },
    { status: 500, reason: /HTTP 500/, action: /retry/i },
  ])(
    "explains HTTP $status without exposing the response body",
    async ({ status, reason, action }) => {
      const error = await readGitHubJsonResponse(
        new Response('{"message":"secret-upstream-body"}', { status }),
      ).catch((failure: unknown) => failure);
      const display = formatControlUiGitHubPreviewError(error);

      expect(display.message).toMatch(reason);
      expect(display.message).toMatch(action);
      expect(display.message).not.toContain("secret-upstream-body");
      expect(display.retryable).toBe(status === 500);
    },
  );

  it("does not distinguish private repositories from missing items", async () => {
    const missing = await readGitHubJsonResponse(new Response(null, { status: 404 })).catch(
      (failure: unknown) => failure,
    );
    expect(
      formatControlUiGitHubPreviewError(
        new ControlUiGitHubError(404, "GitHub repository is not public"),
      ),
    ).toEqual(formatControlUiGitHubPreviewError(missing));
  });

  it("uses a bounded cooldown when rate-limit timing is malformed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const error = await readGitHubJsonResponse(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "secret-upstream-header", "x-ratelimit-reset": "Infinity" },
      }),
    ).catch((failure: unknown) => failure);
    const display = formatControlUiGitHubPreviewError(error);

    expect(display.retryAfterMs).toBe(60_000);
    expect(display.message).toMatch(/rate limit/i);
    expect(display.message).not.toContain("secret-upstream-header");
  });

  it.each([
    { failure: new DOMException("secret-abort-reason", "TimeoutError"), reason: /timed out/i },
    { failure: new TypeError("fetch failed: secret-network-address"), reason: /reach GitHub/i },
  ])("explains transport errors without leaking their diagnostics", async ({ failure, reason }) => {
    const error = await fetchGitHubApi(
      "https://api.github.com/repos/openclaw/openclaw",
      vi.fn<typeof fetch>().mockRejectedValue(failure),
    ).catch((caught: unknown) => caught);
    const display = formatControlUiGitHubPreviewError(error);

    expect(display.message).toMatch(reason);
    expect(display.message).toMatch(/retry/i);
    expect(display.message).not.toContain("secret-");
    expect(display.retryable).toBe(true);
  });

  it("dispatches an admitted request before its caller can retire", async () => {
    let active = true;
    let activeAtDispatch: boolean | undefined;
    const pending = fetchGitHubApi(
      "https://api.github.com/repos/owner/repo/actions/runs",
      async () => {
        activeAtDispatch = active;
        return new Response("{}");
      },
      "synthetic-token",
    );
    active = false;
    await pending;

    expect(activeAtDispatch).toBe(true);
  });

  it("shows configured credential recovery instructions but hides unknown errors", () => {
    const unavailable = new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: "control-ui-github",
      state: "unavailable",
      paths: ["gateway.controlUi.github.token"],
      refKeys: [],
      reason: "secret-store-diagnostic",
    });
    expect(formatControlUiGitHubPreviewError(unavailable)).toEqual({
      message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
      retryable: false,
    });
    const display = formatControlUiGitHubPreviewError(
      new Error("Authorization: Bearer secret-unknown-credential"),
    );
    expect(display.message).toMatch(/retry|logs/i);
    expect(display.message).not.toContain("secret-unknown-credential");
  });
});
