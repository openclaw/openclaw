import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueWorkerGitHubInstallationToken } from "./worker-github-installation-token.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();

function env(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_GITHUB_API_BASE_URL: "https://api.microsoft.ghe.com",
    OPENCLAW_GITHUB_APP_ID: "13361",
    OPENCLAW_GITHUB_INSTALLATION_ID: "119386",
    OPENCLAW_GITHUB_APP_PRIVATE_KEY: pem,
  };
}

describe("worker GitHub App installation-token issuer", () => {
  it("mints full existing installation authority and revokes it once", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          token: "synthetic-full-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const grant = await issueWorkerGitHubInstallationToken({ env: env(), fetch });

    expect(grant?.token).toBe("synthetic-full-installation-token");
    expect(calls[0]?.url).toBe(
      "https://api.microsoft.ghe.com/app/installations/119386/access_tokens",
    );
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer [^.]+\.[^.]+\.[^.]+$/u),
    });
    expect(calls[0]?.init.body).toBe("{}");
    await grant?.revoke();
    await grant?.revoke();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      url: "https://api.microsoft.ghe.com/installation/token",
      init: { method: "DELETE" },
    });
    expect(calls[1]?.init.headers).toMatchObject({
      authorization: "Bearer synthetic-full-installation-token",
    });
  });

  it("fails closed on partial issuer configuration before network access", async () => {
    const fetch = vi.fn();
    const partial = env();
    delete partial.OPENCLAW_GITHUB_INSTALLATION_ID;
    await expect(issueWorkerGitHubInstallationToken({ env: partial, fetch })).rejects.toThrow(
      "configuration is incomplete",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes a malformed issued token before rejecting it", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              token: "synthetic-invalid-token",
              expires_at: "not-a-time",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
    ) as typeof globalThis.fetch;
    await expect(issueWorkerGitHubInstallationToken({ env: env(), fetch })).rejects.toThrow(
      "invalid installation token",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains revocation ownership after a failed delete so cleanup can retry", async () => {
    let deletes = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
      if (init.method === "DELETE") {
        deletes += 1;
        return new Response(null, { status: deletes === 1 ? 503 : 204 });
      }
      return new Response(
        JSON.stringify({
          token: "synthetic-retry-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    const grant = await issueWorkerGitHubInstallationToken({ env: env(), fetch });

    await expect(grant?.revoke()).rejects.toThrow("revocation failed");
    await expect(grant?.revoke()).resolves.toBeUndefined();
    expect(deletes).toBe(2);
  });
});
