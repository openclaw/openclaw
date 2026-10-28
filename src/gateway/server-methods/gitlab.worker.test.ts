import { afterEach, expect, it, vi } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPersonalGitLabOAuthLifecycle } from "../gitlab-personal-oauth.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("links two humans through registered RPC, rejects cross-person/replayed callbacks, and never selects ambient bot credentials", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer: "https://gitlab.example.test",
          clientId: "client-id",
          redirectUri: "https://gateway.example.test/oauth/gitlab",
          projects: [17],
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const clients = ["alice", "bob"].map((name): GatewayClient => {
      const profile = ensureProfileForEmail(`${name}@example.test`);
      return {
        connId: `conn-${name}`,
        authenticatedUserId: `${name}@example.test`,
        authenticatedUserProfile: gatewayProfile(
          profile.id,
          profile.displayName,
          profile.updatedAt,
        ),
        connect: gatewayConnect(["operator.read", "operator.write"], {
          id: "test",
          mode: "test",
          version: "1",
        }),
      };
    });
    const catalog = await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    const context = {
      getRuntimeConfig: () => config,
      gitlabOAuthService: service,
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(clients.filter((c) => !filter || filter(c)).map((c) => c.connId!)),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    const rpc = async (client: GatewayClient, method: string, params = {}) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: `rpc-${method}`, method, params },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      return respond.mock.calls[0]!;
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      const address = url instanceof Request ? url.url : url.toString();
      expect(address.startsWith(config.gateway!.gitlab!.issuer)).toBe(true);
      expect(options?.redirect).toBe("error");
      if (address.endsWith("/oauth/token")) {
        const body = options!.body as URLSearchParams;
        const name = body.get("code") === "alice-code" ? "alice" : "bob";
        return Response.json({
          access_token: `${name}-access`,
          refresh_token: `${name}-refresh`,
          token_type: "bearer",
          expires_in: 7200,
        });
      }
      const token = new Headers(options?.headers).get("Authorization");
      expect(token).not.toContain("ambient-bot");
      if (address.endsWith("/oauth/token/info")) {
        return Response.json({ scope: ["api", "write_repository"] });
      }
      if (address.endsWith("/api/v4/user")) {
        const name = token === "Bearer alice-access" ? "alice" : "bob";
        return Response.json({
          id: name === "alice" ? 101 : 202,
          username: name,
          name,
          commit_email: `${name}@example.test`,
          bot: false,
        });
      }
      throw new Error("Unexpected synthetic request");
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("GITLAB_TOKEN", "ambient-bot");
    try {
      const first = await rpc(clients[0]!, "users.gitlab.authorize.start");
      expect(first[0]).toBe(true);
      const started = first[1] as { requestId: string; authorizationUrl: string };
      expect((await rpc(clients[0]!, "users.gitlab.status"))[1]).toMatchObject({
        pendingRequestId: started.requestId,
      });
      expect((await rpc(clients[1]!, "users.gitlab.status"))[1]).not.toHaveProperty(
        "pendingRequestId",
        started.requestId,
      );
      const callbackUrl = `${config.gateway!.gitlab!.redirectUri}?code=alice-code&state=${new URL(started.authorizationUrl).searchParams.get("state")}`;
      expect(
        (
          await rpc(clients[1]!, "users.gitlab.authorize.complete", {
            requestId: started.requestId,
            callbackUrl,
          })
        )[0],
      ).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        (
          await rpc(clients[0]!, "users.gitlab.authorize.complete", {
            requestId: started.requestId,
            callbackUrl,
          })
        )[0],
      ).toBe(true);
      expect(
        (
          await rpc(clients[0]!, "users.gitlab.authorize.complete", {
            requestId: started.requestId,
            callbackUrl,
          })
        )[0],
      ).toBe(false);
      const second = (await rpc(clients[1]!, "users.gitlab.authorize.start"))[1] as typeof started;
      expect(
        (
          await rpc(clients[1]!, "users.gitlab.authorize.complete", {
            requestId: second.requestId,
            callbackUrl: `${config.gateway!.gitlab!.redirectUri}?code=bob-code&state=${new URL(second.authorizationUrl).searchParams.get("state")}`,
          })
        )[0],
      ).toBe(true);
      const alice = await preparePersonalForgeAction(
        { client: clients[0]!, context },
        "operator.read",
        undefined,
        "GitLab",
      );
      const bob = await preparePersonalForgeAction(
        { client: clients[1]!, context },
        "operator.read",
        undefined,
        "GitLab",
      );
      const aliceCredential = await service.credential(alice);
      const bobCredential = await service.credential(bob);
      expect(aliceCredential.account.accountId).toBe(101);
      expect(bobCredential.account.accountId).toBe(202);
      fetcher.mockClear();
      expect((await rpc(clients[0]!, "users.gitlab.status"))[1]).toMatchObject({
        connected: true,
        account: { accountId: 101, login: "alice" },
      });
      expect(fetcher).toHaveBeenCalled();
      fetcher.mockRejectedValueOnce(new Error("Synthetic provider outage"));
      expect((await rpc(clients[0]!, "users.gitlab.status"))[1]).toMatchObject({
        connected: false,
        verificationUnavailable: true,
        reconnectRequired: false,
      });
      aliceCredential.assertCurrent();
      expect((await rpc(clients[0]!, "users.gitlab.status"))[1]).toMatchObject({
        connected: true,
        verificationUnavailable: false,
        account: { accountId: 101, login: "alice" },
      });
      expect((await rpc(clients[1]!, "users.gitlab.status"))[1]).toMatchObject({ connected: true });
      fetcher.mockClear();
      const rejectedSelection = await rpc(clients[0]!, "sessions.gitlab.publish", {
        sessionKey: "agent:main:gitlab-shared",
        idempotencyKey: "rejected-shared-selection",
        selection: { source: "shared" },
      });
      expect(rejectedSelection).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          message: "GitLab publication session was not found.",
        }),
      ]);
      expect(fetcher).not.toHaveBeenCalled();
      const synthetic: GatewayClient = {
        ...clients[0]!,
        connId: "synthetic-alice",
        internal: { syntheticClient: true },
      };
      clients.push(synthetic);
      fetcher.mockClear();
      expect((await rpc(synthetic, "users.gitlab.status"))[0]).toBe(false);
      expect(
        (
          await rpc(synthetic, "sessions.gitlab.publish", {
            sessionKey: "agent:main:gitlab-shared",
            idempotencyKey: "synthetic-publication",
            selection: {
              source: "personal",
              generation: aliceCredential.generation,
              account: { accountId: 101, login: "alice" },
            },
          })
        )[0],
      ).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      clients.pop();
      clients[0]!.invalidated = true;
      expect(aliceCredential.assertCurrent).toThrow();
      await expect(service.credential(alice)).rejects.toThrow();
      clients[0]!.invalidated = false;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60 * 60 * 1000);
      fetcher.mockRejectedValueOnce(new Error("Synthetic refresh failure"));
      try {
        expect((await rpc(clients[0]!, "users.gitlab.status"))[1]).toMatchObject({
          connected: false,
          reconnectRequired: true,
          verificationUnavailable: false,
        });
      } finally {
        clock.mockRestore();
      }
      expect((await rpc(clients[0]!, "users.gitlab.disconnect"))[0]).toBe(true);
      expect(aliceCredential.assertCurrent).toThrow();
      bobCredential.assertCurrent();
      await expect(service.credential(alice)).rejects.toThrow("Connect your personal");
    } finally {
      await service.stop();
      catalog.release();
    }
  });
});

it("rejects a personal callback after public application metadata changes before token exchange", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer: "https://gitlab.example.test",
          clientId: "public-client",
          redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const owner = ensureProfileForEmail("alice@example.test");
    await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const action = {
      owner: owner.id,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    try {
      const started = await service.start(action);
      const callback = new URL(config.gateway!.gitlab!.redirectUri);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      config.gateway!.gitlab!.clientId = "replacement-public-client";
      await expect(
        service.complete(action, started.requestId, callback.toString()),
      ).rejects.toThrow("GitLab authorization changed");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await service.stop();
    }
  });
});
