import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { listSystemPresence } from "../infra/system-presence.js";
import {
  ensureProfileForEmail,
  getUserProfileDisplay,
  linkEmail,
  resolveUserProfileId,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionSuggestionHandlers } from "./server-methods/sessions-suggestions.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams, makeGatewayClient } from "./server-request-context.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { getHealthVersion, incrementPresenceVersion } from "./server/health-state.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";

vi.mock("./server/health-state.js", () => ({
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 1),
}));

describe("createGatewayRequestContext presence", () => {
  it("refreshes every live connection and presence row for a changed user profile", () => {
    const makeProfileClient = (
      connId: string,
      email: string,
      profile: Partial<NonNullable<GatewayWsClient["authenticatedUserProfile"]>> = {},
    ) => ({
      ...makeGatewayClient({
        connId,
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: email,
      authenticatedUserProfile: {
        profileId: "profile-ada",
        displayName: "Ada",
        avatarRevision: "avatar-old-png",
        hasAvatar: true,
        updatedAt: 1,
        ...profile,
      },
      presenceKey: `profile-refresh-${connId}`,
    });
    const first = makeProfileClient("ada-one", "ada@example.test");
    const second = makeProfileClient("ada-two", "ada@work.test");
    const unrelated = makeProfileClient("grace", "grace@example.test", {
      profileId: "profile-grace",
      displayName: "Grace",
      avatarRevision: "1",
      hasAvatar: false,
    });
    const params = makeContextParams({ clients: new Set([first, second, unrelated]) as never });
    const context = createGatewayRequestContext(params);
    const capturedFirstProfile = first.authenticatedUserProfile;
    const readCapturedDisplayName = () => capturedFirstProfile.displayName;

    const revisions = ["avatar-new-png", "avatar-newer-png"];
    for (const avatarRevision of revisions) {
      context.refreshConnectedUserProfile?.({
        id: "profile-ada",
        displayName: "Augusta Ada",
        avatarRevision,
        hasAvatar: true,
        updatedAt: 2,
      });
    }

    expect(first.authenticatedUserProfile).toEqual({
      profileId: "profile-ada",
      displayName: "Augusta Ada",
      avatarRevision: "avatar-newer-png",
      hasAvatar: true,
      updatedAt: 2,
    });
    expect(first.authenticatedUserProfile).toBe(capturedFirstProfile);
    expect(readCapturedDisplayName()).toBe("Augusta Ada");
    expect(second.authenticatedUserProfile).toEqual(first.authenticatedUserProfile);
    expect(unrelated.authenticatedUserProfile.displayName).toBe("Grace");
    for (const [index, avatarRevision] of revisions.entries()) {
      expect(params.runtime.broadcast).toHaveBeenNthCalledWith(
        index + 1,
        "presence",
        {
          presence: expect.arrayContaining(
            ["ada@example.test", "ada@work.test"].map((email) =>
              expect.objectContaining({
                user: {
                  id: "profile-ada",
                  identity: { type: "profile", id: "profile-ada" },
                  email,
                  name: "Augusta Ada",
                  avatarUrl: `/api/users/profile-ada/avatar?v=${avatarRevision}`,
                },
              }),
            ),
          ),
        },
        { dropIfSlow: true, stateVersion: { presence: 1, health: 1 } },
      );
    }
  });

  it("canonicalizes a connected profile after its durable identity is merged", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("merge-source@example.test");
      const target = ensureProfileForEmail("merge-target@example.test");
      const unrelatedProfile = ensureProfileForEmail("merge-unrelated@example.test");
      const sourceClient = {
        ...makeGatewayClient({
          connId: "merge-source",
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserId: "merge-source@example.test",
        authenticatedUserProfile: {
          profileId: source.id,
          displayName: source.displayName,
          avatarRevision: String(source.updatedAt),
          hasAvatar: false,
          updatedAt: source.updatedAt,
        },
        presenceKey: "profile-refresh-merge-source",
        personPresence: { onlineSince: 1_000, lastActivityAt: 2_000 },
      };
      const targetClient = {
        ...sourceClient,
        connId: "merge-target",
        authenticatedUserId: "merge-target@example.test",
        authenticatedUserProfile: {
          ...sourceClient.authenticatedUserProfile,
          profileId: target.id,
        },
        presenceKey: "profile-refresh-merge-target",
        personPresence: { onlineSince: 1_500, lastActivityAt: 3_000 },
      };
      const unrelatedClient = {
        ...makeGatewayClient({
          connId: "merge-unrelated",
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserId: "merge-unrelated@example.test",
        authenticatedUserProfile: {
          profileId: unrelatedProfile.id,
          displayName: unrelatedProfile.displayName,
          avatarRevision: String(unrelatedProfile.updatedAt),
          hasAvatar: false,
          updatedAt: unrelatedProfile.updatedAt,
        },
        presenceKey: "profile-refresh-merge-unrelated",
      };
      const capturedProfile = sourceClient.authenticatedUserProfile;
      const params = makeContextParams({
        clients: new Set([sourceClient, targetClient, unrelatedClient]) as never,
      });
      const context = createGatewayRequestContext(params);

      const linked = linkEmail("merge-source@example.test", target.id);
      expect(resolveUserProfileId(source.id)).toBe(target.id);
      const display = getUserProfileDisplay(linked.id);
      context.refreshConnectedUserProfile?.({
        ...display,
        updatedAt: linked.updatedAt,
      });

      expect(sourceClient.authenticatedUserProfile).toBe(capturedProfile);
      expect(sourceClient.authenticatedUserProfile).toEqual({
        profileId: target.id,
        displayName: target.displayName,
        avatarRevision: display.avatarRevision,
        hasAvatar: false,
        updatedAt: linked.updatedAt,
      });
      expect(unrelatedClient.authenticatedUserProfile.profileId).toBe(unrelatedProfile.id);
      for (const email of ["merge-source@example.test", "merge-target@example.test"]) {
        expect(listSystemPresence().find((entry) => entry.user?.email === email)).toMatchObject({
          user: { id: target.id, identity: { type: "profile", id: target.id } },
          onlineSince: 1_000,
          lastActivityAt: 3_000,
        });
      }
      const presence = vi.mocked(params.runtime.broadcast).mock.calls[0]?.[1] as {
        presence?: Array<{ user?: { id?: string; email?: string; avatarUrl?: string } }>;
      };
      expect(
        presence.presence?.find((entry) => entry.user?.email === "merge-source@example.test")?.user,
      ).toEqual({
        id: target.id,
        identity: { type: "profile", id: target.id },
        email: "merge-source@example.test",
        name: target.displayName,
        avatarUrl: `/api/users/${target.id}/avatar?v=${display.avatarRevision}`,
      });
      expect(presence.presence?.some((entry) => entry.user?.id === unrelatedProfile.id)).toBe(
        false,
      );
    });
  });

  it("publishes an owner rename to every tab without inventing an email", () => {
    const ownerClients = [];
    for (const tab of ["one", "two"]) {
      ownerClients.push({
        ...makeGatewayClient({
          connId: `owner-${tab}`,
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserProfile: {
          profileId: "profile-owner",
          displayName: "Ada",
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: 1,
        },
        presenceKey: `profile-owner-${tab}`,
        personPresence: { onlineSince: 1_000 },
      });
    }
    const params = makeContextParams({ clients: new Set(ownerClients) as never });
    createGatewayRequestContext(params).refreshConnectedUserProfile?.({
      id: "profile-owner",
      displayName: "Augusta Ada",
      avatarRevision: "2",
      hasAvatar: false,
      updatedAt: 2,
    });

    for (const client of ownerClients) {
      expect(client.authenticatedUserProfile.displayName).toBe("Augusta Ada");
    }
    const ownerRows = listSystemPresence().filter((entry) => entry.user?.id === "profile-owner");
    expect(ownerRows).toHaveLength(2);
    for (const entry of ownerRows) {
      expect(entry.user).toEqual({
        id: "profile-owner",
        identity: { type: "profile", id: "profile-owner" },
        name: "Augusta Ada",
        avatarUrl: "/api/users/profile-owner/avatar?v=2",
      });
    }
    expect(params.runtime.broadcast).toHaveBeenCalledExactlyOnceWith(
      "presence",
      { presence: expect.arrayContaining(ownerRows) },
      { dropIfSlow: true, stateVersion: { presence: 1, health: 1 } },
    );
  });

  it("publishes only server-stamped activity from the exact live client", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    onTestFinished(() => now.mockRestore());
    const client: GatewayWsClient = {
      ...makeGatewayClient({ connId: "activity-live", clientId: GATEWAY_CLIENT_IDS.CONTROL_UI }),
      socket: { readyState: 1 } as GatewayWsClient["socket"],
      usesSharedGatewayAuth: false,
      presenceKey: "activity-live",
      authenticatedUserId: "live@activity.test",
      personPresence: { onlineSince: 9_000 },
    };
    const clients = new GatewayClientRegistry([client]);
    const params = makeContextParams({ clients });
    const context = createGatewayRequestContext(params);
    context.recordClientActivity?.({ ...client });
    expect(params.runtime.broadcast).not.toHaveBeenCalled();
    context.recordClientActivity?.(client);
    expect(params.runtime.broadcast).toHaveBeenCalledExactlyOnceWith(
      "presence",
      {
        presence: expect.arrayContaining([
          expect.objectContaining({
            user: { id: "live@activity.test", email: "live@activity.test" },
            onlineSince: 9_000,
            lastActivityAt: 10_000,
          }),
        ]),
      },
      { dropIfSlow: true, stateVersion: { presence: 1, health: 1 } },
    );
    now.mockReturnValue(11_000);
    clients.delete(client);
    context.recordClientActivity?.(client);
    expect(params.runtime.broadcast).toHaveBeenCalledOnce();
  });

  it("coalesces typing activity across a person's tabs without delaying explicit presence changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const started = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(started);
      const increment = vi.mocked(incrementPresenceVersion);
      const health = vi.mocked(getHealthVersion);
      const previousIncrement = increment.getMockImplementation()!;
      const previousHealth = health.getMockImplementation()!;
      let presenceVersion = 0;
      increment.mockImplementation(() => ++presenceVersion);
      health.mockReturnValue(11);
      onTestFinished(() => {
        clock.mockRestore();
        increment.mockImplementation(previousIncrement);
        health.mockImplementation(previousHealth);
      });
      const profile = ensureProfileForEmail("typing-presence@example.test");
      const sessionKey = "agent:main:typing-presence-coalescing";
      const sessionId = "typing-presence-coalescing";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: started,
          createdActor: { type: "human", source: "profile", id: profile.id },
          visibility: "shared",
        },
      );
      const tabs = ["first", "second"].map((tab, index): GatewayWsClient =>
        Object.assign(
          makeGatewayClient({
            connId: `typing-presence-${tab}`,
            clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            scopes: ["operator.read", "operator.write"],
          }),
          {
            socket: { readyState: 1 } as GatewayWsClient["socket"],
            usesSharedGatewayAuth: false,
            presenceKey: `typing-presence-${tab}`,
            authenticatedUserId: "typing-presence@example.test",
            authenticatedUserProfile: {
              profileId: profile.id,
              displayName: "Typing Person",
              avatarRevision: "1",
              hasAvatar: false,
              updatedAt: started,
            },
            personPresence: { onlineSince: started - 2_000 + index * 1_000 },
          },
        ),
      );
      const params = makeContextParams({ clients: new GatewayClientRegistry(tabs) });
      const context = createGatewayRequestContext(params);
      const events = () =>
        vi.mocked(params.runtime.broadcast).mock.calls.filter(([event]) => event === "presence");
      const rows = () =>
        listSystemPresence().filter((entry) => entry.user?.identity?.id === profile.id);
      const typeAt = async (offset: number, tab = tabs[0]!) => {
        clock.mockReturnValue(started + offset);
        const requestParams = { sessionKey, sessionId, typing: true };
        const respond = vi.fn();
        await sessionSuggestionHandlers["session.typing"]!({
          req: {
            type: "req",
            id: `typing-${offset}`,
            method: "session.typing",
            params: requestParams,
          },
          params: requestParams,
          client: tab,
          context,
          isWebchatConnect: () => true,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(true, { ok: true, broadcast: false });
      };

      for (let second = 0; second < 30; second++) {
        await typeAt(second * 1_000, tabs[second % tabs.length]!);
      }
      // Typing is still accepted on every request; full roster publication is coarser.
      expect(events()).toHaveLength(1);
      expect(rows()).toHaveLength(2);
      for (const row of rows()) {
        expect(row).toMatchObject({
          onlineSince: started - 2_000,
          lastActivityAt: started + 29_000,
        });
      }
      await typeAt(30_000);
      expect(events()).toHaveLength(2);

      clock.mockReturnValue(started + 31_000);
      context.refreshConnectedUserProfile?.({
        id: profile.id,
        displayName: "Renamed Person",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: started + 31_000,
      });
      expect(events()).toHaveLength(3);
      expect(rows().every((row) => row.user?.name === "Renamed Person")).toBe(true);
      health.mockReturnValue(12);
      broadcastPresenceSnapshot(context);
      expect(events()).toHaveLength(4);
      await typeAt(32_000, tabs[1]!);
      expect(events()).toHaveLength(4);

      clock.mockReturnValue(started + 179_000);
      context.refreshConnectedUserProfile?.({
        id: profile.id,
        displayName: "Renamed Again",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: started + 179_000,
      });
      expect(events()).toHaveLength(5);
      await typeAt(180_000, tabs[1]!);
      expect(events()).toHaveLength(6);
      expect(events().map((call) => call[2]?.stateVersion)).toEqual([
        { presence: 1, health: 11 },
        { presence: 2, health: 11 },
        { presence: 3, health: 11 },
        { presence: 4, health: 12 },
        { presence: 5, health: 12 },
        { presence: 6, health: 12 },
      ]);
      expect(presenceVersion).toBe(6);
      expect(events().at(-1)?.[1]).toMatchObject({
        presence: expect.arrayContaining([
          expect.objectContaining({
            onlineSince: started - 2_000,
            lastActivityAt: started + 180_000,
          }),
        ]),
      });
    });
  });

  it.each(["removed", "invalidated", "closing"] as const)(
    "does not refresh a %s profile connection or resurrect its presence",
    (state) => {
      const client: GatewayWsClient = {
        ...makeGatewayClient({
          connId: `profile-${state}`,
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        socket: { readyState: state === "closing" ? 2 : 1 } as GatewayWsClient["socket"],
        usesSharedGatewayAuth: false,
        authenticatedUserId: `${state}@profile.test`,
        authenticatedUserProfile: {
          profileId: `inactive-${state}`,
          displayName: "Before",
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: 1,
        },
        presenceKey: `profile-${state}`,
        invalidated: state === "invalidated",
      };
      const params = makeContextParams({
        clients: new GatewayClientRegistry(state === "removed" ? [] : [client]),
      });
      createGatewayRequestContext(params).refreshConnectedUserProfile?.({
        id: `inactive-${state}`,
        displayName: "After",
        avatarRevision: "2",
        hasAvatar: false,
        updatedAt: 2,
      });
      expect(client.authenticatedUserProfile?.displayName).toBe("Before");
      expect(params.runtime.broadcast).not.toHaveBeenCalled();
      expect(
        listSystemPresence().some((entry) => entry.user?.email === `${state}@profile.test`),
      ).toBe(false);
    },
  );

  it("preserves the Gravatar-backed route when a changed profile has no upload", () => {
    const client = {
      ...makeGatewayClient({
        connId: "ada-avatar-removed",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: {
        profileId: "profile-ada-avatar-removed",
        displayName: "Ada",
        avatarRevision: "avatar-upload-png",
        hasAvatar: true,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-ada-avatar-removed",
    };
    const params = makeContextParams({ clients: new Set([client]) as never });
    const context = createGatewayRequestContext(params);

    context.refreshConnectedUserProfile?.({
      id: "profile-ada-avatar-removed",
      displayName: "Ada",
      avatarRevision: "profile-updated-2",
      hasAvatar: false,
      updatedAt: 2,
    });

    expect(client.authenticatedUserProfile.hasAvatar).toBe(false);
    const presence = vi.mocked(params.runtime.broadcast).mock.calls[0]?.[1] as {
      presence?: Array<{ user?: { id?: string; avatarUrl?: string } }>;
    };
    expect(
      presence.presence?.find((entry) => entry.user?.id === "profile-ada-avatar-removed")?.user,
    ).toEqual({
      id: "profile-ada-avatar-removed",
      identity: { type: "profile", id: "profile-ada-avatar-removed" },
      email: "ada@example.test",
      name: "Ada",
      avatarUrl: "/api/users/profile-ada-avatar-removed/avatar?v=profile-updated-2",
    });
  });

  it("keeps Tailscale provider identities out of refreshed presence email", () => {
    const client = {
      ...makeGatewayClient({
        connId: "ada-tailscale",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      authenticatedUserProfile: {
        profileId: "profile-ada-tailscale",
        displayName: "Ada",
        avatarRevision: "avatar-tailscale-png",
        hasAvatar: true,
        updatedAt: 1,
      },
      presenceKey: "profile-refresh-ada-tailscale",
    };
    const params = makeContextParams({ clients: new Set([client]) as never });
    const context = createGatewayRequestContext(params);

    context.refreshConnectedUserProfile?.({
      id: "profile-ada-tailscale",
      displayName: "Augusta Ada",
      avatarRevision: "avatar-tailscale-new-png",
      hasAvatar: true,
      updatedAt: 2,
    });

    const presence = vi.mocked(params.runtime.broadcast).mock.calls[0]?.[1] as {
      presence?: Array<{ user?: { id?: string; email?: string } }>;
    };
    expect(
      presence.presence?.find((entry) => entry.user?.id === "profile-ada-tailscale")?.user,
    ).toEqual({
      id: "profile-ada-tailscale",
      identity: { type: "profile", id: "profile-ada-tailscale" },
      name: "Augusta Ada",
      avatarUrl: "/api/users/profile-ada-tailscale/avatar?v=avatar-tailscale-new-png",
    });
  });
});
