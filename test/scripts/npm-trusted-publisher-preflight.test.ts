import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightNpmTrustedPublisher } from "../../scripts/npm-trusted-publisher-preflight.mjs";

const githubRequestToken = "github-request-secret";
const githubOidcToken = "github-oidc-secret";
const npmToken = "npm-exchange-secret";
const packageName = "@openclaw/fish-audio-speech";
const preflight = () => preflightNpmTrustedPublisher(packageName);
const requestUrl = "https://token.actions.githubusercontent.com/request?job=123";
const auth = (token: string) => ({ Accept: "application/json", Authorization: `Bearer ${token}` });
const exchange = (body: unknown, status = 200) => [
  Response.json({ value: githubOidcToken }),
  Response.json(body, { status }),
];

function mockResponses(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("npm trusted-publisher preflight", () => {
  beforeEach(() => {
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", requestUrl);
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", githubRequestToken);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the npm audience and exchanges the GitHub token for the exact package", async () => {
    const fetchMock = mockResponses(...exchange({ token: npmToken }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await preflight();

    expect(fetchMock.mock.calls).toMatchObject([
      [`${requestUrl}&audience=npm%3Aregistry.npmjs.org`, { headers: auth(githubRequestToken) }],
      [
        "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@openclaw%2ffish-audio-speech",
        { method: "POST", headers: auth(githubOidcToken) },
      ],
    ]);
    expect(log).toHaveBeenCalledWith(
      "npm trusted-publisher OIDC exchange verified for @openclaw/fish-audio-speech.",
    );
  });

  it.each([
    ["GitHub OIDC token request failed (HTTP 403).", () => [Response.json({}, { status: 403 })], 1],
    [
      `npm trusted-publisher exchange for ${packageName} failed (HTTP 404).`,
      () => exchange({ message: `${githubRequestToken} ${githubOidcToken} ${npmToken}` }, 404),
      2,
    ],
    [
      `npm trusted-publisher exchange for ${packageName} response is missing token.`,
      () => exchange({ token: "" }),
      2,
    ],
  ] as const)("reports %s without leaking tokens", async (message, responses, calls) => {
    const fetchMock = mockResponses(...responses());
    const error = await preflight().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const visibleError = error instanceof Error ? error.message : String(error);
    expect(visibleError).toBe(message);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    for (const token of [githubRequestToken, githubOidcToken, npmToken]) {
      expect(visibleError).not.toContain(token);
    }
  });
});
