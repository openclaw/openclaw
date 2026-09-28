import { afterEach, describe, expect, it, vi } from "vitest";
import { listSystemPresence } from "../../infra/system-presence.js";
import { recordClientPresenceActivity } from "./client-presence.js";
import { GatewayClientRegistry } from "./client-registry.js";
import type { GatewayWsClient } from "./ws-types.js";

describe("person activity after clock rollback", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([1, 2])("records exact activity and resets publication across %s tabs", (tabCount) => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const profileId = `clock-person-${tabCount}`;
    const tabs = Array.from({ length: tabCount }, (_, index): GatewayWsClient => ({
      socket: { readyState: 1 } as GatewayWsClient["socket"],
      connId: `${profileId}-${index}`,
      presenceKey: `${profileId}-${index}`,
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      },
      authenticatedUserProfile: {
        profileId,
        displayName: "Clock Person",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: started,
      },
      personPresence: { onlineSince: started - 120_000 },
    }));
    const clients = new GatewayClientRegistry(tabs);
    expect(recordClientPresenceActivity(clients, tabs[0]!)).toBe(true);
    clock.mockReturnValue(started - 60_000);
    expect(recordClientPresenceActivity(clients, tabs[0]!)).toBe(true);
    clock.mockReturnValue(started - 59_000);
    expect(recordClientPresenceActivity(clients, tabs.at(-1)!)).toBe(false);

    const rows = listSystemPresence().filter((entry) => entry.user?.id === profileId);
    expect(rows).toHaveLength(tabCount);
    for (const row of rows) {
      expect(row).toMatchObject({
        onlineSince: started - 120_000,
        lastActivityAt: started - 59_000,
      });
    }
    clock.mockReturnValue(started - 30_000);
    expect(recordClientPresenceActivity(clients, tabs.at(-1)!)).toBe(true);
  });
});
