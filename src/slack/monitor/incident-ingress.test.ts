import { describe, expect, it } from "vitest";
import { resolveSlackIncidentIngressDrop } from "./incident-ingress.js";

const baseConfig = {
  allowed: true,
  requireMention: false,
  allowImplicitMention: false,
  incidentRootOnly: true,
  incidentIgnoreResolved: true,
  incidentDedupeWindowSeconds: 300,
};

describe("resolveSlackIncidentIngressDrop", () => {
  it("drops non-root thread updates when root-only is enabled", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "update",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "Incident update",
    });
    expect(res).toEqual({ shouldDrop: true, reason: "incident-non-root-update" });
  });

  it("drops resolved incident updates", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "Status: resolved",
        ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "Status: resolved",
    });
    expect(res).toEqual({ shouldDrop: true, reason: "incident-resolved-update" });
  });

  it("passes through when channelConfig is null", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: null,
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "plain message",
        ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "plain message",
    });
    expect(res).toEqual({ shouldDrop: false });
  });

  it("drops duplicate incident roots inside the dedupe window", () => {
    const dedupeStore = new Map<string, number>();
    const first = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "API latency high",
        ts: "1",
        user: "U1",
        type: "message",
      },
      now: 1_000,
      rawBody: "API latency high",
    });
    const second = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "API latency high",
        ts: "2",
        user: "U1",
        type: "message",
      },
      now: 2_000,
      rawBody: "API latency high",
    });
    expect(first).toEqual({ shouldDrop: false });
    expect(second).toEqual({ shouldDrop: true, reason: "incident-duplicate" });
  });

  it("allows identical incidents again after the dedupe window expires", () => {
    const dedupeStore = new Map<string, number>();
    const first = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "API latency high",
        ts: "1",
        user: "U1",
        type: "message",
      },
      now: 1_000,
      rawBody: "API latency high",
    });
    const second = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "API latency high",
        ts: "2",
        user: "U1",
        type: "message",
      },
      now: 302_000,
      rawBody: "API latency high",
    });
    expect(first).toEqual({ shouldDrop: false });
    expect(second).toEqual({ shouldDrop: false });
  });

  it("bypasses dedupe when the cooldown is disabled", () => {
    const dedupeStore = new Map<string, number>();
    const disabledConfig = { ...baseConfig, incidentDedupeWindowSeconds: 0 };
    const first = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: disabledConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "API latency high",
        ts: "1",
        user: "U1",
        type: "message",
      },
      now: 1_000,
      rawBody: "API latency high",
    });
    const second = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: disabledConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "API latency high",
        ts: "2",
        user: "U1",
        type: "message",
      },
      now: 2_000,
      rawBody: "API latency high",
    });
    expect(first).toEqual({ shouldDrop: false });
    expect(second).toEqual({ shouldDrop: false });
  });

  it("caps stored incident fingerprints after pruning", () => {
    const dedupeStore = new Map<string, number>();
    for (let i = 0; i < 512; i += 1) {
      dedupeStore.set(`default:C1:${i}`, 10_000 + i);
    }

    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "fresh incident",
        ts: "999",
        user: "U1",
        type: "message",
      },
      now: 2_000,
      rawBody: "fresh incident",
    });

    expect(res).toEqual({ shouldDrop: false });
    expect(dedupeStore.size).toBeLessThanOrEqual(512);
  });

  it("matches other resolved-status phrases and avoids false positives", () => {
    const recovered = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "monitoring recovered",
        ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "monitoring recovered",
    });
    const negative = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: baseConfig,
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "Resolution plan attached",
        ts: "2",
        user: "U1",
        type: "message",
      },
      rawBody: "Resolution plan attached",
    });
    expect(recovered).toEqual({ shouldDrop: true, reason: "incident-resolved-update" });
    expect(negative).toEqual({ shouldDrop: false });
  });
});
