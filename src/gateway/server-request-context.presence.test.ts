import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { listSystemPresence } from "../infra/system-presence.js";
import {
  getUserProfileDisplay,
  prepareUserProfileCatalog,
  readResidentUserProfileId,
} from "../state/user-profile-list.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { sessionSuggestionHandlers } from "./server-methods/sessions-suggestions.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams, makeGatewayClient } from "./server-request-context.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { getHealthVersion, incrementPresenceVersion } from "./server/health-state.js";
import { createPresencePublisher } from "./server/presence-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";

vi.mock("./server/health-state.js", () => ({
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 1),
}));

function makePresenceContextParams(overrides: Parameters<typeof makeContextParams>[0] = {}) {
  const presenceClock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(presenceClock.clock);
  const params = makeContextParams(overrides);
  const publisher = createPresencePublisher({
    scheduler,
    broadcast: params.runtime.broadcast,
    incrementPresenceVersion,
    getHealthVersion,
    prepare: () => undefined,
  });
  params.runtime.publishPresence = publisher.publish;
  onTestFinished(async () => {
    publisher.stop();
    await scheduler.stop();
  });
  return { ...params, presenceClock };
}

function makeProfileClient(
  connId: string,
  email: string | undefined,
  profile: Partial<NonNullable<GatewayWsClient["authenticatedUserProfile"]>> = {},
) {
  return {
    ...makeGatewayClient({ connId, clientId: GATEWAY_CLIENT_IDS.CONTROL_UI }),
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
  };
}

function makeStoredProfileClient(name: string) {
  const email = `merge-${name}@example.test`;
  const profile = ensureProfileForEmail(email);
  return makeProfileClient(`merge-${name}`, email, {
    profileId: profile.id,
    displayName: profile.displayName,
    avatarRevision: String(profile.updatedAt),
    hasAvatar: false,
    updatedAt: profile.updatedAt,
  });
}

describe("createGatewayRequestContext presence", () => {
  it.each([
    {
      identity: "email",
      emails: ["ada@example.test", "ada@work.test"],
      revisions: ["avatar-new-png", "avatar-newer-png"],
    },
    { identity: "owner", emails: [undefined, undefined], revisions: ["2"] },
    { identity: "tailscale", emails: ["ada@github"], revisions: ["avatar-tailscale-new-png"] },
  ])(
    "refreshes every live profile connection with $identity identity",
    async ({ identity, emails, revisions }) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
      onTestFinished(() => {
        clock.mockRestore();
      });
      const profileId = `profile-${identity}`;
      const clients = emails.map((email, index) => ({
        ...makeProfileClient(`${identity}-${index}`, email, { profileId }),
        ...(identity === "owner" ? { personPresence: { onlineSince: 1_000 } } : {}),
        ...(identity === "tailscale" ? { authenticatedUserIsTailscaleProvider: true } : {}),
      }));
      const unrelated = makeProfileClient("grace", "grace@example.test", {
        profileId: "profile-grace",
        displayName: "Grace",
        avatarRevision: "1",
        hasAvatar: false,
      });
      const params = makePresenceContextParams({
        clients: new Set([...clients, unrelated]) as never,
      });
      const context = createGatewayRequestContext(params);
      const first = clients[0]!;
      const capturedProfile = first.authenticatedUserProfile;
      const expectedUser = (email: string | undefined, avatarRevision: string) => ({
        id: profileId,
        identity: { type: "profile", id: profileId },
        ...(identity === "email" ? { email } : {}),
        name: "Augusta Ada",
        avatarUrl: `/api/users/${profileId}/avatar?v=${avatarRevision}`,
      });
      for (const [index, avatarRevision] of revisions.entries()) {
        context.refreshConnectedUserProfile?.({
          id: profileId,
          displayName: "Augusta Ada",
          avatarRevision,
          hasAvatar: identity !== "owner" && index === 0,
          updatedAt: 2,
        });
        await params.presenceClock.advanceBy(200);
        expect(params.runtime.broadcast).toHaveBeenNthCalledWith(
          index + 1,
          "presence",
          {
            presence: expect.arrayContaining(
              emails.map((email) =>
                expect.objectContaining({ user: expectedUser(email, avatarRevision) }),
              ),
            ),
          },
          expect.anything(),
        );
      }
      expect(params.runtime.broadcast).toHaveBeenCalledTimes(revisions.length);
      expect(first.authenticatedUserProfile).toBe(capturedProfile);
      for (const client of clients) {
        expect(client.authenticatedUserProfile).toEqual({
          profileId,
          displayName: "Augusta Ada",
          avatarRevision: revisions.at(-1),
          hasAvatar: identity === "tailscale",
          updatedAt: 2,
        });
      }
      expect(unrelated.authenticatedUserProfile.displayName).toBe("Grace");
      const rows = listSystemPresence().filter((entry) => entry.user?.id === profileId);
      expect(rows).toHaveLength(clients.length);
      const newestFirstEmails = emails.toReversed();
      for (const [index, row] of rows.entries()) {
        expect(row.user).toEqual(expectedUser(newestFirstEmails[index], revisions.at(-1)!));
      }
      if (identity === "email") {
        expect(rows[0]!.ts).toBeGreaterThan(rows[1]!.ts);
      }
    },
  );

  it("canonicalizes a connected profile after its durable identity is merged", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const sourceClient = makeStoredProfileClient("source");
      const targetClient = makeStoredProfileClient("target");
      const unrelatedClient = makeStoredProfileClient("unrelated");
      const sourceId = sourceClient.authenticatedUserProfile.profileId;
      const target = { ...targetClient.authenticatedUserProfile };
      const unrelatedId = unrelatedClient.authenticatedUserProfile.profileId;
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      Object.assign(sourceClient, {
        personPresence: { onlineSince: 1_000, lastActivityAt: 2_000 },
      });
      Object.assign(targetClient, {
        personPresence: { onlineSince: 1_500, lastActivityAt: 3_000 },
      });
      const capturedProfile = sourceClient.authenticatedUserProfile;
      const params = makePresenceContextParams({
        clients: new Set([sourceClient, targetClient, unrelatedClient]) as never,
      });
      const context = createGatewayRequestContext(params);

      const { profile: linked } = await linkCanonicalUserProfileEmail(
        "merge-source@example.test",
        target.profileId,
      );
      expect(readResidentUserProfileId(sourceId)).toBe(target.profileId);
      const display = getUserProfileDisplay(linked.id);
      context.refreshConnectedUserProfile?.({ ...display, updatedAt: linked.updatedAt });
      await params.presenceClock.advanceBy(200);

      expect(sourceClient.authenticatedUserProfile).toBe(capturedProfile);
      expect(sourceClient.authenticatedUserProfile).toEqual({
        profileId: target.profileId,
        displayName: target.displayName,
        avatarRevision: display.avatarRevision,
        hasAvatar: false,
        updatedAt: linked.updatedAt,
      });
      expect(unrelatedClient.authenticatedUserProfile.profileId).toBe(unrelatedId);
      for (const email of ["merge-source@example.test", "merge-target@example.test"]) {
        expect(listSystemPresence().find((entry) => entry.user?.email === email)).toMatchObject({
          user: { id: target.profileId, identity: { type: "profile", id: target.profileId } },
          onlineSince: 1_000,
          lastActivityAt: 3_000,
        });
      }
      const { presence } = vi.mocked(params.runtime.broadcast).mock.calls[0]![1] as {
        presence: ReturnType<typeof listSystemPresence>;
      };
      expect(
        presence.find((entry) => entry.user?.email === "merge-source@example.test")?.user,
      ).toEqual({
        id: target.profileId,
        identity: { type: "profile", id: target.profileId },
        email: "merge-source@example.test",
        name: target.displayName,
        avatarUrl: `/api/users/${target.profileId}/avatar?v=${display.avatarRevision}`,
      });
      expect(presence.some((entry) => entry.user?.id === unrelatedId)).toBe(false);
    });
  });

  it("coalesces typing activity across a person's tabs and publishes explicit changes after the coalescing window", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      await captureRuntimeConfigAsyncReader()();
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
          makeProfileClient(`typing-presence-${tab}`, "typing-presence@example.test", {
            profileId: profile.id,
            displayName: "Typing Person",
            avatarRevision: "1",
            hasAvatar: false,
            updatedAt: started,
          }),
          {
            socket: { readyState: 1 } as GatewayWsClient["socket"],
            usesSharedGatewayAuth: false,
            personPresence: { onlineSince: started - 2_000 + index * 1_000 },
          },
        ),
      );
      for (const tab of tabs) {
        tab.connect.client.mode = GATEWAY_CLIENT_MODES.WEBCHAT;
        tab.connect.scopes = ["operator.read", "operator.write"];
      }
      const params = makePresenceContextParams({ clients: new GatewayClientRegistry(tabs) });
      const context = createGatewayRequestContext(params);
      await initializeSessionReadContext(context);
      const events = () =>
        vi.mocked(params.runtime.broadcast).mock.calls.filter(([event]) => event === "presence");
      const rows = () =>
        listSystemPresence().filter((entry) => entry.user?.identity?.id === profile.id);
      const renameAt = async (offset: number, displayName: string) => {
        clock.mockReturnValue(started + offset);
        context.refreshConnectedUserProfile?.({
          id: profile.id,
          displayName,
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: started + offset,
        });
        await params.presenceClock.advanceBy(200);
      };
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
        await params.presenceClock.advanceBy(200);
      };

      for (let second = 0; second < 30; second++) {
        await typeAt(second * 1_000, tabs[second % tabs.length]!);
      }
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

      await renameAt(31_000, "Renamed Person");
      expect(events()).toHaveLength(3);
      expect(rows().every((row) => row.user?.name === "Renamed Person")).toBe(true);
      health.mockReturnValue(12);
      context.publishPresence();
      await params.presenceClock.advanceBy(200);
      expect(events()).toHaveLength(4);
      await typeAt(32_000, tabs[1]!);
      expect(events()).toHaveLength(4);

      await renameAt(179_000, "Renamed Again");
      expect(events()).toHaveLength(5);
      await typeAt(180_000, tabs[1]!);
      expect(events()).toHaveLength(6);
      expect(events().map((call) => call[2]?.stateVersion)).toEqual(
        [11, 11, 11, 12, 12, 12].map((version, index) => ({
          presence: index + 1,
          health: version,
        })),
      );
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

  it.each(["invalidated", "closing"] as const)(
    "does not refresh a %s profile connection or resurrect its presence",
    async (state) => {
      const client: GatewayWsClient = {
        ...makeProfileClient(`profile-${state}`, `${state}@profile.test`, {
          profileId: `inactive-${state}`,
          displayName: "Before",
          avatarRevision: "1",
          hasAvatar: false,
        }),
        socket: { readyState: state === "closing" ? 2 : 1 } as GatewayWsClient["socket"],
        usesSharedGatewayAuth: false,
        invalidated: state === "invalidated",
      };
      const params = makePresenceContextParams({
        clients: new GatewayClientRegistry([client]),
      });
      createGatewayRequestContext(params).refreshConnectedUserProfile?.({
        id: `inactive-${state}`,
        displayName: "After",
        avatarRevision: "2",
        hasAvatar: false,
        updatedAt: 2,
      });
      await params.presenceClock.advanceBy(200);
      expect(client.authenticatedUserProfile?.displayName).toBe("Before");
      expect(params.runtime.broadcast).not.toHaveBeenCalled();
      expect(
        listSystemPresence().some((entry) => entry.user?.email === `${state}@profile.test`),
      ).toBe(false);
    },
  );
});
