import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightNpmTrustedPublisher } from "../../scripts/npm-trusted-publisher-preflight.mjs";

const githubRequestToken = "github-request-secret";
const githubOidcToken = "github-oidc-secret";
const npmToken = "npm-exchange-secret";
const packageName = "@openclaw/fish-audio-speech";
const preflight = () => preflightNpmTrustedPublisher(packageName);

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
    vi.stubEnv(
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "https://token.actions.githubusercontent.com/request?job=123",
    );
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", githubRequestToken);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the npm audience and exchanges the GitHub token for the exact package", async () => {
    const fetchMock = mockResponses(
      Response.json({ value: githubOidcToken }),
      Response.json({ token: npmToken }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await preflight();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://token.actions.githubusercontent.com/request?job=123&audience=npm%3Aregistry.npmjs.org",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: `Bearer ${githubRequestToken}`,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@openclaw%2ffish-audio-speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: `Bearer ${githubOidcToken}`,
        }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      "npm trusted-publisher OIDC exchange verified for @openclaw/fish-audio-speech.",
    );
  });

  it("reports a GitHub token request failure without attempting npm exchange", async () => {
    const fetchMock = mockResponses(Response.json({}, { status: 403 }));

    await expect(preflight()).rejects.toThrow("GitHub OIDC token request failed (HTTP 403).");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an npm exchange failure without leaking response or request tokens", async () => {
    mockResponses(
      Response.json({ value: githubOidcToken }),
      Response.json(
        { message: `${githubRequestToken} ${githubOidcToken} ${npmToken}` },
        { status: 404 },
      ),
    );

    const error = await preflight().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const visibleError = error instanceof Error ? error.message : String(error);
    expect(visibleError).toBe(
      "npm trusted-publisher exchange for @openclaw/fish-audio-speech failed (HTTP 404).",
    );
    expect(visibleError).not.toContain(githubRequestToken);
    expect(visibleError).not.toContain(githubOidcToken);
    expect(visibleError).not.toContain(npmToken);
  });

  it("rejects an npm exchange response without a token", async () => {
    mockResponses(Response.json({ value: githubOidcToken }), Response.json({ token: "" }));

    await expect(preflight()).rejects.toThrow(
      "npm trusted-publisher exchange for @openclaw/fish-audio-speech response is missing token.",
    );
  });
});
