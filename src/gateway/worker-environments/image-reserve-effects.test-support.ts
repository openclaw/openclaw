import { generateKeyPairSync, verify } from "node:crypto";
import http from "node:http";
import { buffer } from "node:stream/consumers";
import { expect, onTestFinished, vi } from "vitest";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import type { GitHubAppSelection } from "../../agents/github-credential-reader.js";
import { fixture as gitFixture, TOKEN, URL } from "./repository-git-pack.test-support.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const api = "https://api.github.com";
const permissions = { contents: "read", metadata: "read" } as const;

/** Only external GitHub/Git endpoints are translated; native signing and Git execute unchanged. */
export async function imageReserveEffectsFixture() {
  const git = await gitFixture({ setupRecipe: false });
  const selection: GitHubAppSelection = {
    kind: "app-installation",
    profileId: "ghp_00000000000000000000000000000001",
    app: {
      appId: 101,
      installationId: 202,
      accountId: 303,
      repositories: [{ id: 404, fullName: "openclaw/private-preparation-fixture" }],
      permissions,
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      keyVersion: "fixture-v1",
    },
  };
  const counts = { issued: 0, revoked: 0, verified: 0 };
  const hooks: { afterMetadata?: () => void } = {};
  const failures: string[] = [];
  const serve = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const endpoint = request.url ?? "";
    const authorization = request.headers.authorization ?? "";
    if (endpoint === "/installation/token" && request.method === "DELETE") {
      expect(authorization).toBe("Bearer " + TOKEN);
      counts.revoked++;
      git.mode.reject = true;
      response.writeHead(204).end();
      return;
    }
    if (endpoint.startsWith("/app")) {
      const [header, payload, signature] = authorization.slice(7).split(".");
      if (!header || !payload || !signature) {
        throw new Error("App JWT missing");
      }
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(header + "." + payload),
          keys.publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
        iss: "101",
      });
    } else {
      expect(authorization).toBe("Bearer " + TOKEN);
    }
    let value: unknown;
    if (endpoint === "/user") {
      counts.verified++;
      value = { id: 42, login: "managed-fixture" };
    } else if (endpoint === "/app") {
      value = { id: 101, slug: "image-proof", permissions };
    } else if (endpoint === "/app/installations/202") {
      value = { id: 202, app_id: 101, account: { id: 303 }, suspended_at: null, permissions };
      hooks.afterMetadata?.();
    } else if (endpoint === "/app/installations/202/access_tokens") {
      expect(request.method).toBe("POST");
      expect(JSON.parse((await buffer(request)).toString())).toEqual({
        repository_ids: [404],
        permissions,
      });
      counts.issued++;
      git.mode.reject = false;
      value = {
        token: TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions,
      };
    } else if (endpoint === "/users/image-proof%5Bbot%5D") {
      value = { id: 9001, login: "image-proof[bot]", type: "Bot", avatar_url: null };
    } else if (endpoint === "/installation/repositories?per_page=100") {
      value = {
        total_count: 1,
        repositories: [{ id: 404, full_name: "openclaw/private-preparation-fixture" }],
      };
    } else {
      throw new Error("Unexpected fixture API endpoint: " + endpoint);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  };
  const server = http.createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500).end();
    });
  });
  const origin = await listenLoopback(server);
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof nativeFetch>[0], init?: RequestInit) =>
    nativeFetch(
      typeof input === "string" && input.startsWith(api) ? origin + input.slice(api.length) : input,
      init,
    ),
  );
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    expect(failures).toEqual([]);
  });
  return {
    git,
    selection,
    counts,
    hooks,
    url: URL,
    translate: (value: string) => value.replaceAll(URL, git.endpoint),
  };
}
