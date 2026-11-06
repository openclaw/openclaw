import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { gitHubPublicApi as api } from "./github-public-api.js";

const repoUrl = "https://api.github.com/repos/owner/repo";
const now = 1_800_000_000_000;
const caught = (error: unknown) => error;
type RequestOptions = {
  url?: string;
  token?: string;
  identity?: Parameters<typeof api.fetchGitHubApi>[4];
  signal?: AbortSignal;
  graphql?: Parameters<typeof api.fetchGitHubApi>[7];
};
function request(fetchImpl: typeof fetch, options: RequestOptions = {}) {
  const { url = repoUrl, token, identity, signal, graphql } = options;
  return api.fetchGitHubApi(url, fetchImpl, token, undefined, identity, undefined, signal, graphql);
}
async function displayError(promise: Promise<unknown>) {
  return api.formatControlUiGitHubPreviewError(await promise.catch(caught));
}

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
    await expect(request(fetchImpl, { identity, signal: controller.signal })).rejects.toBe(
      cancelled,
    );
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
    await once(signal, "abort");
    throw new DOMException("Request aborted", "AbortError");
  });
  const pending = request(fetchImpl, { signal: controller.signal });
  const signal = await started.promise;
  expect(signal).not.toBe(controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ statusCode: 502 });
  expect(signal.aborted).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  ["core", "/user/1", "/repos/owner/repo", "/search/repositories", 403],
  ["graphql", "/graphql", "/graphql", "/repos/owner/repo", 200],
] as const)(
  "shares %s quota cooldown without blocking other buckets or credentials",
  async (resource, limited, sibling, independent, status) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), {
          status,
          headers: {
            "x-ratelimit-resource": resource,
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000090",
          },
        }),
      )
      .mockImplementation(async () => new Response("{}"));
    const read = async (path: string, token = "quota-token") => {
      const response = await request(fetchMock, {
        url: `https://api.github.com${path}`,
        token,
        graphql:
          path === "/graphql" ? { query: "query { viewer { login } }", variables: {} } : undefined,
      });
      return path === "/graphql"
        ? api.readGitHubGraphQLResponse(response, fetchMock, token)
        : api.readGitHubJsonResponse(response);
    };
    await expect(read(limited)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 90_000,
    });
    clock.mockReturnValue(now + 10_000);
    await expect(read(sibling)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 80_000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(read(independent)).resolves.toEqual({});
    await expect(read(sibling, "rotated-token")).resolves.toEqual({});
    clock.mockReturnValue(now + 90_000);
    await expect(read(sibling)).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(4);
  },
);

it("retains the longest concurrent cooldown and rechecks live identity before rejecting", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const firstResponse = createDeferred<Response>();
  const secondResponse = createDeferred<Response>();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(async () => firstResponse.promise)
    .mockImplementationOnce(async () => secondResponse.promise);
  const read = () => api.fetchGitHubJson("https://api.github.com/user/1", fetchMock).catch(caught);
  const first = read();
  const second = read();
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
  await expect(request(fetchMock, { url: "https://api.github.com/user/1", identity })).rejects.toBe(
    retired,
  );
  expect(identity.revalidate).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  [403, /access denied/i, /repository access/i, false],
  [new TypeError("fetch failed: secret-network-address"), /reach GitHub/i, /retry/i, true],
] as const)(
  "explains %s without exposing diagnostics",
  async (failure, reason, action, retryable) => {
    const display = await displayError(
      typeof failure === "number"
        ? api.readGitHubJsonResponse(
            new Response('{"message":"secret-upstream-body"}', { status: failure }),
          )
        : request(vi.fn<typeof fetch>().mockRejectedValue(failure), {
            url: "https://api.github.com/repos/openclaw/openclaw",
          }),
    );
    expect(display).toMatchObject({ message: expect.stringMatching(reason), retryable });
    expect(display.message).toMatch(action);
    expect(display.message).not.toContain("secret-");
  },
);

it("does not distinguish private repositories from missing items", async () => {
  const missing = await displayError(
    api.readGitHubJsonResponse(new Response(null, { status: 404 })),
  );
  expect(
    api.formatControlUiGitHubPreviewError(
      new api.ControlUiGitHubError(404, "GitHub repository is not public"),
    ),
  ).toEqual(missing);
});

it("uses a bounded cooldown when HTTP 429 timing is malformed", async () => {
  const headers = { "retry-after": "secret-upstream-header", "x-ratelimit-reset": "Infinity" };
  vi.spyOn(Date, "now").mockReturnValue(now);
  const error = await api
    .readGitHubJsonResponse(new Response(null, { status: 429, headers }))
    .catch(caught);
  const display = api.formatControlUiGitHubPreviewError(error);

  expect(error).toMatchObject({ retryAtMs: now + 60_000 });
  expect(display).toMatchObject({
    retryAfterMs: 60_000,
    message: expect.stringMatching(/rate limit/i),
  });
  expect(display.message).not.toContain("secret-upstream-header");
});

it("dispatches an admitted request before its caller can retire", async () => {
  let active = true;
  let activeAtDispatch: boolean | undefined;
  const pending = request(
    async () => {
      activeAtDispatch = active;
      return new Response("{}");
    },
    { url: `${repoUrl}/actions/runs`, token: "synthetic-token" },
  );
  active = false;
  await pending;

  expect(activeAtDispatch).toBe(true);
});

it("hides unknown errors", () => {
  const display = api.formatControlUiGitHubPreviewError(
    new Error("Authorization: Bearer secret-unknown-credential"),
  );
  expect(display.message).toMatch(/retry|logs/i);
  expect(display.message).not.toContain("secret-unknown-credential");
});
