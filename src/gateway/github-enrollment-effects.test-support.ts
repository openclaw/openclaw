import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { vi } from "vitest";
import { clearGitHubCredentialVerificationCache } from "../agents/github-oauth-client.js";
import {
  resolveManagedGitHubProfileDir,
  resolveManagedGitHubProfileRoot,
} from "../agents/github-tool-profile-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { readUserGitHubConnectionAsync } from "../state/user-github-connections.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { createPersonalGitHubOAuthLifecycle } from "./github-personal-oauth.js";
import { preparePersonalGitHubActionV2 } from "./server-methods/github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

export const syntheticAccessToken = "synthetic-enrollment-access-token";
export const syntheticRefreshToken = "synthetic-enrollment-refresh-token";
const devicePath = "/login/device/code";
const tokenPath = "/login/oauth/access_token";
const accountPath = "/user";

/** Synthetic issuer only: real HTTP and production parsers, not an external GitHub OAuth grant. */
export async function createSyntheticGitHubEnrollmentIssuer() {
  const requests: { path: string; method: string; body: string; authorization?: string }[] = [];
  let beforeReply: ((pathname: string) => Promise<void>) | undefined;
  async function respond(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const pathname = req.url ?? "";
    requests.push({
      path: pathname,
      method: req.method ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
      authorization: req.headers.authorization,
    });
    await beforeReply?.(pathname);
    res.setHeader("content-type", "application/json");
    res.setHeader("x-oauth-scopes", "repo, workflow, read:org, gist");
    const body =
      pathname === devicePath
        ? {
            device_code: "d".repeat(40),
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }
        : pathname === tokenPath
          ? {
              access_token: syntheticAccessToken,
              refresh_token: syntheticRefreshToken,
              token_type: "bearer",
              scope: "repo workflow read:org gist",
              expires_in: 28800,
              refresh_token_expires_in: 15897600,
            }
          : pathname === accountPath
            ? { id: 4242, login: "synthetic-enrollee" }
            : undefined;
    res.statusCode = body ? 200 : 404;
    res.end(JSON.stringify(body ?? { error: "unexpected_route" }));
  }
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        void respond(req, res).catch(() => {
          res.statusCode = 500;
          res.end("{}");
        });
      }),
  });
  const origin = `http://127.0.0.1:${reservation.claim.port}`;
  return {
    requests,
    devicePath,
    tokenPath,
    accountPath,
    reset() {
      requests.length = 0;
      beforeReply = undefined;
    },
    beforeReply(callback: (pathname: string) => Promise<void>) {
      beforeReply = callback;
    },
    routeFetch() {
      const realFetch = globalThis.fetch;
      return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (
          !(
            (url.origin === "https://github.com" &&
              [devicePath, tokenPath].includes(url.pathname)) ||
            (url.origin === "https://api.github.com" && url.pathname === accountPath)
          )
        ) {
          throw new Error("Enrollment proof refused unexpected external HTTP");
        }
        return realFetch(new URL(url.pathname, origin), init);
      });
    },
    async close() {
      reservation.listener.closeAllConnections();
      try {
        await reservation.releaseListener();
      } finally {
        await reservation.claim.release();
      }
    },
  };
}

export type SyntheticEnrollmentIssuer = Awaited<
  ReturnType<typeof createSyntheticGitHubEnrollmentIssuer>
>;

export async function withGitHubEnrollmentEffectFixture(
  issuer: SyntheticEnrollmentIssuer,
  run: (fixture: {
    lifecycle: ReturnType<typeof createPersonalGitHubOAuthLifecycle>;
    action: Awaited<ReturnType<typeof preparePersonalGitHubActionV2>>;
    restrict: () => void;
    pendingProfile: () => void;
    advancePoll: () => void;
    readConnection: () => ReturnType<typeof readUserGitHubConnectionAsync>;
    installedHosts: () => Promise<string[]>;
    readHosts: (profileId: string) => Promise<string>;
  }) => Promise<void>,
) {
  issuer.reset();
  clearGitHubCredentialVerificationCache();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const bin = state.path("synthetic-bin");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, process.platform === "win32" ? "gh.cmd" : "gh"),
      "#!/bin/sh\nexit 77\n",
      { mode: 0o755 },
    );
    // Preflight checks availability only. The proof must never execute native gh credentials.
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
    const owner = (await ensureCanonicalUserProfileForEmail("enrollment@example.test")).id;
    const catalog = await prepareUserProfileCatalog();
    let config: OpenClawConfig = {
      gateway: {
        roles: {
          default: "member",
          definitions: {
            member: { scopes: ["operator.read"], sessions: { others: "none" }, agents: [] },
            restricted: {
              scopes: ["operator.read.no-credential-enrollment"],
              sessions: { others: "none" },
              agents: [],
            },
          },
        },
      },
    };
    const client: GatewayClient = {
      connId: "enrollment-effect-proof",
      authenticatedUserProfile: {
        profileId: owner,
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        role: "operator",
        scopes: ["operator.read"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", mode: "test", platform: "test", version: "1" },
      },
    };
    const context = {
      getRuntimeConfig: () => config,
      getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
        new Set(!filter || filter(client) ? [client.connId!] : []),
    } as unknown as GatewayRequestContext;
    const action = await preparePersonalGitHubActionV2(
      { client, context },
      "operator.read",
      undefined,
      "users.github.authorize.start",
    );
    const lifecycle = createPersonalGitHubOAuthLifecycle();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = issuer.routeFetch();
    const root = resolveManagedGitHubProfileRoot({ scope: "personal", agentId: "" });
    try {
      await run({
        lifecycle,
        action,
        restrict() {
          config = {
            ...config,
            gateway: {
              ...config.gateway,
              roles: { ...config.gateway!.roles!, default: "restricted" },
            },
          };
        },
        pendingProfile() {
          client.authenticatedUserProfile = undefined;
          client.authenticatedGitHubIdentitySync = async () => ({ profileId: owner, updatedAt: 1 });
        },
        advancePoll() {
          now += 1001;
        },
        readConnection: () => readUserGitHubConnectionAsync(owner),
        async installedHosts() {
          try {
            return (await fs.readdir(root, { recursive: true })).filter((name) =>
              name.endsWith("hosts.yml"),
            );
          } catch (error) {
            if (hasErrnoCode(error, "ENOENT")) {
              return [];
            }
            throw error;
          }
        },
        readHosts: (profileId) =>
          fs.readFile(
            path.join(
              resolveManagedGitHubProfileDir({ scope: "personal", agentId: "", profileId }),
              "hosts.yml",
            ),
            "utf8",
          ),
      });
    } finally {
      await lifecycle.stop();
      fetch.mockRestore();
      clock.mockRestore();
      catalog.release();
      clearGitHubCredentialVerificationCache();
    }
  });
}
