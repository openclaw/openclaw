import { afterEach, expect, it, vi } from "vitest";
import {
  inspectGitLabManagedOAuthRecord,
  readGitLabManagedSetupRecord,
  writeGitLabManagedOAuthRecord,
} from "../agents/gitlab-managed-records.js";
import { retireManagedGitLabProfile } from "../agents/gitlab-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedGitLabOAuthLifecycle } from "./gitlab-managed-oauth.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { PersonalForgeAction } from "./server-methods/personal-forge-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
});

it("binds managed setup to its administrator, exact target and current issuer before any exchange", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer: "https://gitlab.example.test",
          clientId: "client-id",
          redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const lifecycle = createManagedGitLabOAuthLifecycle({
      getConfig: () => config,
      getPersistedConfig: async () => config,
    });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const action = (owner: string): PersonalForgeAction => ({
      owner,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const alice = action("administrator-alice");
    const bob = action("administrator-bob");
    const callback = (started: { authorizationUrl: string }) => {
      const url = new URL(config.gateway!.gitlab!.redirectUri);
      url.searchParams.set("code", "synthetic-code");
      url.searchParams.set("state", new URL(started.authorizationUrl).searchParams.get("state")!);
      return url.toString();
    };
    try {
      const first = await lifecycle.start(alice, { scope: "system", agentId: "main" });
      expect(await readGitLabManagedSetupRecord(first.requestId)).toMatchObject({
        scope: "system",
        agentId: "main",
        initiatorProfileId: alice.owner,
        expectedIdentity: null,
      });
      await expect(lifecycle.complete(bob, first.requestId, callback(first))).rejects.toThrow();
      await expect(lifecycle.cancel(bob, first.requestId)).rejects.toThrow();
      expect(await readGitLabManagedSetupRecord(first.requestId)).not.toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
      const replacement = await lifecycle.start(alice, { scope: "system", agentId: "main" });
      expect(await readGitLabManagedSetupRecord(first.requestId)).toBeUndefined();
      await expect(lifecycle.complete(alice, first.requestId, callback(first))).rejects.toThrow();
      const wrongState = new URL(callback(replacement));
      wrongState.searchParams.set("state", "different-state");
      await expect(
        lifecycle.complete(alice, replacement.requestId, wrongState.toString()),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      config.gateway!.gitlab!.clientId = "replacement-application";
      await expect(
        lifecycle.complete(alice, replacement.requestId, callback(replacement)),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      expect(await lifecycle.cancel(alice, replacement.requestId)).toEqual({ cancelled: true });
      expect(await lifecycle.cancel(alice, replacement.requestId)).toEqual({ cancelled: false });
    } finally {
      await lifecycle.stop();
    }
  });
});

it("activates only the accepted system target and consumes its callback exactly once", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { readFileSync } = await import("node:fs");
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer: "https://gitlab.example.test",
          clientId: "client-id",
          redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
        },
      },
    };
    await state.writeConfig(config);
    const current = () => JSON.parse(readFileSync(state.configPath, "utf8")) as OpenClawConfig;
    let runtime: OpenClawConfig | undefined;
    const live = () => runtime ?? current();
    const lifecycle = createManagedGitLabOAuthLifecycle({
      getConfig: live,
      getPersistedConfig: async () => current(),
    });
    const action: PersonalForgeAction = {
      owner: "administrator-alice",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      const address = url instanceof Request ? url.url : url.toString();
      expect(address.startsWith(config.gateway!.gitlab!.issuer + "/")).toBe(true);
      expect(options?.redirect).toBe("error");
      if (address.endsWith("/oauth/token")) {
        return Response.json({
          access_token: "synthetic-managed-access",
          refresh_token: "synthetic-managed-refresh",
          token_type: "bearer",
          expires_in: 7200,
        });
      }
      if (address.endsWith("/oauth/token/info")) {
        return Response.json({ scope: ["api", "write_repository"] });
      }
      if (address.endsWith("/api/v4/user")) {
        return Response.json({
          id: 42,
          username: "selected-system-account",
          name: "Selected Account",
          commit_email: "selected@example.test",
          bot: true,
        });
      }
      throw new Error("Unexpected synthetic request");
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const started = await lifecycle.start(action, { scope: "system", agentId: "main" });
      const callback = new URL(config.gateway!.gitlab!.redirectUri);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      expect(
        await lifecycle.complete(action, started.requestId, callback.toString()),
      ).toMatchObject({
        connected: true,
        scope: "system",
        account: { accountId: 42, login: "selected-system-account" },
        configCommitted: true,
      });
      expect(current().tools?.gitlab?.profileId).toMatch(/^glp_[a-f0-9]{32}$/);
      expect(current().agents?.entries?.main?.tools?.gitlab).toBeUndefined();
      const status = await lifecycle.status({ scope: "agent", agentId: "main" });
      expect(status).toMatchObject({
        selected: null,
        effectiveSource: "system-configured",
        effective: { credentialState: "available", account: { accountId: 42 } },
      });
      fetcher.mockClear();
      await expect(
        lifecycle.complete(action, started.requestId, callback.toString()),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      const profileId = current().tools!.gitlab!.profileId;
      const inspected = await inspectGitLabManagedOAuthRecord(profileId);
      if (inspected.state !== "valid") {
        throw new Error("Missing synthetic managed record");
      }
      await writeGitLabManagedOAuthRecord(
        {
          ...inspected.record,
          pendingInitial: { requestId: started.requestId, expectedIdentity: null },
        },
        inspected.record,
      );
      runtime = config;
      await lifecycle.status({ scope: "system", agentId: "main" });
      const pending = await inspectGitLabManagedOAuthRecord(profileId);
      expect(pending.state === "valid" && pending.record.pendingInitial).toBeTruthy();
      runtime = undefined;
      await lifecycle.status({ scope: "system", agentId: "main" });
      const settled = await inspectGitLabManagedOAuthRecord(profileId);
      expect(settled.state === "valid" && settled.record.pendingInitial).toBeUndefined();
      runtime = current();
      expect(
        await retireManagedGitLabProfile({
          config: runtime,
          getCurrentConfig: live,
          scope: "system",
          agentId: "main",
        }),
      ).toEqual({ retired: true, cleanupPending: true });
      expect(current().tools?.gitlab).toBeUndefined();
      await lifecycle.reconcile();
      expect((await inspectGitLabManagedOAuthRecord(profileId)).state).toBe("valid");
      runtime = undefined;
      await lifecycle.reconcile();
      expect((await inspectGitLabManagedOAuthRecord(profileId)).state).not.toBe("valid");
      await writeGitLabManagedOAuthRecord({
        ...inspected.record,
        pendingInitial: { requestId: started.requestId, expectedIdentity: null },
      });
      await lifecycle.reconcile();
      expect((await inspectGitLabManagedOAuthRecord(profileId)).state).not.toBe("valid");
    } finally {
      await lifecycle.stop();
    }
  });
});

it("enforces current administrator authority through registered managed-connection RPC", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer: "https://gitlab.example.test",
          clientId: "client-id",
          redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
        },
        roles: {
          definitions: {
            administrator: {
              scopes: ["operator.admin"],
              agents: "*",
              sessions: { others: "write" },
            },
            member: {
              scopes: ["operator.read", "operator.write"],
              agents: "*",
              sessions: { others: "none" },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const clients = ["administrator", "member"].map((role): GatewayClient => {
      const profile = ensureProfileForEmail(`${role}@example.test`);
      setUserProfileRole(profile.id, role);
      return {
        connId: `connection-${role}`,
        authenticatedUserId: `${role}@example.test`,
        authenticatedUserProfile: gatewayProfile(
          profile.id,
          profile.displayName,
          profile.updatedAt,
        ),
        connect: gatewayConnect(["operator.admin"], { id: "test", mode: "test", version: "1" }),
      };
    });
    const catalog = await prepareUserProfileCatalog();
    const service = createManagedGitLabOAuthLifecycle({
      getConfig: () => config,
      getPersistedConfig: async () => config,
    });
    const context = {
      getRuntimeConfig: () => config,
      gitlabManagedOAuthService: service,
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          clients.filter((client) => !filter || filter(client)).map((client) => client.connId!),
        ),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    const rpc = async (client: GatewayClient, method: string, params = {}) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: method, method, params },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      return respond.mock.calls[0]!;
    };
    try {
      expect(
        (
          await rpc(clients[1]!, "tools.gitlab.authorize.start", {
            scope: "system",
            agentId: "main",
          })
        )[0],
      ).toBe(false);
      const started = await rpc(clients[0]!, "tools.gitlab.authorize.start", {
        scope: "system",
        agentId: "main",
      });
      expect(started[0]).toBe(true);
      const requestId = (started[1] as { requestId: string }).requestId;
      expect((await rpc(clients[1]!, "tools.gitlab.authorize.cancel", { requestId }))[0]).toBe(
        false,
      );
      expect(await readGitLabManagedSetupRecord(requestId)).not.toBeUndefined();
      expect((await rpc(clients[0]!, "tools.gitlab.authorize.cancel", { requestId }))[1]).toEqual({
        cancelled: true,
      });
      expect(await readGitLabManagedSetupRecord(requestId)).toBeUndefined();
      const next = (
        await rpc(clients[0]!, "tools.gitlab.authorize.start", {
          scope: "system",
          agentId: "main",
        })
      )[1] as { requestId: string; authorizationUrl: string };
      let releaseToken!: (response: Response) => void;
      const tokenResponse = new Promise<Response>((resolve) => {
        releaseToken = resolve;
      });
      const fetcher = vi.fn<typeof fetch>().mockReturnValue(tokenResponse);
      vi.stubGlobal("fetch", fetcher);
      const callback = new URL(config.gateway!.gitlab!.redirectUri);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", new URL(next.authorizationUrl).searchParams.get("state")!);
      const completing = rpc(clients[0]!, "tools.gitlab.authorize.complete", {
        requestId: next.requestId,
        callbackUrl: callback.toString(),
      });
      try {
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        setUserProfileRole(clients[0]!.authenticatedUserProfile!.profileId, "member");
      } finally {
        releaseToken(
          Response.json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            token_type: "bearer",
            expires_in: 7200,
          }),
        );
      }
      expect((await completing)[0]).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(config.tools?.gitlab).toBeUndefined();
    } finally {
      await service.stop();
      catalog.release();
    }
  });
});
