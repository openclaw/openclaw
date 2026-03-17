import { describe, expect, it } from "vitest";
import {
  getTransportProfile,
  isPassiveChannel,
  isPollingChannel,
  registerChannelTransport,
  resolveChannelTransport,
} from "./oag-channel-profiles.js";

describe("resolveChannelTransport", () => {
  it("maps websocket channels correctly", () => {
    expect(resolveChannelTransport("discord")).toBe("websocket");
    expect(resolveChannelTransport("slack")).toBe("websocket");
    expect(resolveChannelTransport("whatsapp")).toBe("websocket");
    expect(resolveChannelTransport("mattermost")).toBe("websocket");
    expect(resolveChannelTransport("irc")).toBe("websocket");
  });

  it("maps polling channels correctly", () => {
    expect(resolveChannelTransport("telegram")).toBe("polling");
    expect(resolveChannelTransport("matrix")).toBe("polling");
    expect(resolveChannelTransport("zalo")).toBe("polling");
    expect(resolveChannelTransport("zalouser")).toBe("polling");
    expect(resolveChannelTransport("nextcloud-talk")).toBe("polling");
    expect(resolveChannelTransport("tlon")).toBe("polling");
    expect(resolveChannelTransport("nostr")).toBe("polling");
  });

  it("maps webhook channels correctly", () => {
    expect(resolveChannelTransport("line")).toBe("webhook");
    expect(resolveChannelTransport("googlechat")).toBe("webhook");
    expect(resolveChannelTransport("msteams")).toBe("webhook");
    expect(resolveChannelTransport("synology-chat")).toBe("webhook");
  });

  it("maps local channels correctly", () => {
    expect(resolveChannelTransport("imessage")).toBe("local");
    expect(resolveChannelTransport("bluebubbles")).toBe("local");
    expect(resolveChannelTransport("signal")).toBe("local");
  });

  it("defaults unknown channels to websocket", () => {
    expect(resolveChannelTransport("unknown-channel")).toBe("websocket");
    expect(resolveChannelTransport("")).toBe("websocket");
  });
});

describe("getTransportProfile", () => {
  it("returns websocket profile defaults", () => {
    const profile = getTransportProfile("discord");
    expect(profile.transport).toBe("websocket");
    expect(profile.staleThresholdMs).toBe(30 * 60_000);
    expect(profile.recoveryBudgetMs).toBe(30_000);
    expect(profile.maxRetries).toBe(5);
    expect(profile.stalePollFactor).toBe(1);
    expect(profile.restartBackoffInitialMs).toBe(5_000);
    expect(profile.restartBackoffMaxMs).toBe(5 * 60_000);
  });

  it("returns polling profile defaults", () => {
    const profile = getTransportProfile("telegram");
    expect(profile.transport).toBe("polling");
    expect(profile.staleThresholdMs).toBe(30 * 60_000);
    expect(profile.recoveryBudgetMs).toBe(90_000);
    expect(profile.maxRetries).toBe(8);
    expect(profile.stalePollFactor).toBe(2);
    expect(profile.restartBackoffInitialMs).toBe(10_000);
    expect(profile.restartBackoffMaxMs).toBe(10 * 60_000);
  });

  it("returns webhook profile defaults", () => {
    const profile = getTransportProfile("line");
    expect(profile.transport).toBe("webhook");
    expect(profile.staleThresholdMs).toBe(0);
    expect(profile.recoveryBudgetMs).toBe(60_000);
    expect(profile.maxRetries).toBe(5);
    expect(profile.stalePollFactor).toBe(1);
  });

  it("returns local profile defaults", () => {
    const profile = getTransportProfile("signal");
    expect(profile.transport).toBe("local");
    expect(profile.staleThresholdMs).toBe(30 * 60_000);
    expect(profile.recoveryBudgetMs).toBe(15_000);
    expect(profile.maxRetries).toBe(3);
    expect(profile.stalePollFactor).toBe(2);
    expect(profile.restartBackoffInitialMs).toBe(3_000);
    expect(profile.restartBackoffMaxMs).toBe(2 * 60_000);
  });

  it("returns websocket profile for unknown channels", () => {
    const profile = getTransportProfile("some-future-channel");
    expect(profile.transport).toBe("websocket");
  });
});

describe("registerChannelTransport", () => {
  it("registers a new channel transport at runtime", () => {
    expect(resolveChannelTransport("my-custom-channel")).toBe("websocket"); // default
    registerChannelTransport("my-custom-channel", "polling");
    expect(resolveChannelTransport("my-custom-channel")).toBe("polling");
    // Clean up: restore to a known state so other tests aren't affected.
    registerChannelTransport("my-custom-channel", "websocket");
  });

  it("overrides an existing channel transport", () => {
    const original = resolveChannelTransport("discord");
    expect(original).toBe("websocket");
    registerChannelTransport("discord", "polling");
    expect(resolveChannelTransport("discord")).toBe("polling");
    // Restore
    registerChannelTransport("discord", "websocket");
  });
});

describe("isPollingChannel", () => {
  it("returns true for polling channels", () => {
    expect(isPollingChannel("telegram")).toBe(true);
    expect(isPollingChannel("matrix")).toBe(true);
    expect(isPollingChannel("zalo")).toBe(true);
    expect(isPollingChannel("nostr")).toBe(true);
  });

  it("returns true for local channels (local uses polling pattern)", () => {
    expect(isPollingChannel("signal")).toBe(true);
    expect(isPollingChannel("imessage")).toBe(true);
    expect(isPollingChannel("bluebubbles")).toBe(true);
  });

  it("returns false for websocket channels", () => {
    expect(isPollingChannel("discord")).toBe(false);
    expect(isPollingChannel("slack")).toBe(false);
  });

  it("returns false for webhook channels", () => {
    expect(isPollingChannel("line")).toBe(false);
    expect(isPollingChannel("msteams")).toBe(false);
  });
});

describe("isPassiveChannel", () => {
  it("returns true for webhook channels", () => {
    expect(isPassiveChannel("line")).toBe(true);
    expect(isPassiveChannel("googlechat")).toBe(true);
    expect(isPassiveChannel("msteams")).toBe(true);
    expect(isPassiveChannel("synology-chat")).toBe(true);
  });

  it("returns false for non-webhook channels", () => {
    expect(isPassiveChannel("discord")).toBe(false);
    expect(isPassiveChannel("telegram")).toBe(false);
    expect(isPassiveChannel("signal")).toBe(false);
  });
});
