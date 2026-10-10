import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  gitHubPublicApi,
} from "./github-public-api.js";

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
        gitHubPublicApi.fetchGitHubApi(
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
    const request = gitHubPublicApi.fetchGitHubApi(
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

  it.each([
    {
      resource: "core",
      limited: "/user/1",
      sibling: "/repos/owner/repo",
      independent: "/search/repositories",
    },
    {
      resource: "graphql",
      limited: "/graphql",
      sibling: "/graphql",
      independent: "/repos/owner/repo",
      status: 200,
    },
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
        const response = await gitHubPublicApi.fetchGitHubApi(
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
          ? gitHubPublicApi.readGitHubGraphQLResponse(response, fetchMock, token)
          : gitHubPublicApi.readGitHubJsonResponse(response);
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

  it("retains the longest concurrent cooldown and rechecks live identity before rejecting", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const firstResponse = createDeferred<Response>();
    const secondResponse = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => firstResponse.promise)
      .mockImplementationOnce(async () => secondResponse.promise);
    const request = () =>
      gitHubPublicApi
        .fetchGitHubJson("https://api.github.com/user/1", fetchMock)
        .catch((error: unknown) => error);
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
      gitHubPublicApi.fetchGitHubApi(
        "https://api.github.com/user/1",
        fetchMock,
        undefined,
        undefined,
        identity,
      ),
    ).rejects.toBe(retired);
    expect(identity.revalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[403, /access denied/i, /repository access/i]])(
    "explains HTTP %s without exposing the response body",
    async (status, reason, action) => {
      const error = await gitHubPublicApi
        .readGitHubJsonResponse(new Response('{"message":"secret-upstream-body"}', { status }))
        .catch((failure: unknown) => failure);
      const display = gitHubPublicApi.formatControlUiGitHubPreviewError(error);

      expect(display.message).toMatch(reason);
      expect(display.message).toMatch(action);
      expect(display.message).not.toContain("secret-upstream-body");
      expect(display.retryable).toBe(status === 500);
    },
  );

  it("does not distinguish private repositories from missing items", async () => {
    const missing = await gitHubPublicApi
      .readGitHubJsonResponse(new Response(null, { status: 404 }))
      .catch((failure: unknown) => failure);
    expect(
      gitHubPublicApi.formatControlUiGitHubPreviewError(
        new gitHubPublicApi.ControlUiGitHubError(404, "GitHub repository is not public"),
      ),
    ).toEqual(gitHubPublicApi.formatControlUiGitHubPreviewError(missing));
  });

  it.each<{ status: number; headers: Record<string, string> }>([
    {
      status: 429,
      headers: { "retry-after": "secret-upstream-header", "x-ratelimit-reset": "Infinity" },
    },
  ])(
    "uses a bounded cooldown when HTTP $status timing is malformed",
    async ({ status, headers }) => {
      const now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const error = await gitHubPublicApi
        .readGitHubJsonResponse(new Response(null, { status, headers }))
        .catch((failure: unknown) => failure);
      const display = gitHubPublicApi.formatControlUiGitHubPreviewError(error);

      expect(error).toMatchObject({ retryAtMs: now + 60_000 });
      expect(display.retryAfterMs).toBe(60_000);
      expect(display.message).toMatch(/rate limit/i);
      expect(display.message).not.toContain("secret-upstream-header");
    },
  );

  it.each([
    { failure: new TypeError("fetch failed: secret-network-address"), reason: /reach GitHub/i },
  ])("explains transport errors without leaking their diagnostics", async ({ failure, reason }) => {
    const error = await gitHubPublicApi
      .fetchGitHubApi(
        "https://api.github.com/repos/openclaw/openclaw",
        vi.fn<typeof fetch>().mockRejectedValue(failure),
      )
      .catch((caught: unknown) => caught);
    const display = gitHubPublicApi.formatControlUiGitHubPreviewError(error);

    expect(display.message).toMatch(reason);
    expect(display.message).toMatch(/retry/i);
    expect(display.message).not.toContain("secret-");
    expect(display.retryable).toBe(true);
  });

  it("dispatches an admitted request before its caller can retire", async () => {
    let active = true;
    let activeAtDispatch: boolean | undefined;
    const pending = gitHubPublicApi.fetchGitHubApi(
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
    expect(gitHubPublicApi.formatControlUiGitHubPreviewError(unavailable)).toEqual({
      message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
      retryable: false,
    });
    const display = gitHubPublicApi.formatControlUiGitHubPreviewError(
      new Error("Authorization: Bearer secret-unknown-credential"),
    );
    expect(display.message).toMatch(/retry|logs/i);
    expect(display.message).not.toContain("secret-unknown-credential");
  });
});
