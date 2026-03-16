import { describe, expect, it } from "vitest";
import {
  isResolvedSlackIncidentUpdateText,
  resolveSlackIncidentIngressDrop,
} from "./incident-ingress.js";

const baseConfig = {
  allowed: true,
  requireMention: false,
  allowImplicitMention: false,
  incidentRootOnly: true,
  allowHumanThreadFollowups: false,
  incidentIgnoreResolved: true,
  incidentDedupeWindowSeconds: 300,
};

describe("resolveSlackIncidentIngressDrop", () => {
  it("treats missing resolved-update text as not resolved", () => {
    expect(isResolvedSlackIncidentUpdateText(undefined)).toBe(false);
    expect(isResolvedSlackIncidentUpdateText(null)).toBe(false);
  });

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

  it("allows approved human thread follow-ups past root-only filtering", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: true,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "follow-up",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "follow-up",
    });

    expect(res).toEqual({ shouldDrop: false });
  });

  it("does not bypass root-only filtering when the config flag is off", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: true,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: false },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "follow-up",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "follow-up",
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

  it("does not suppress human follow-ups that mention resolution", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: true,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "is it resolved now?",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "is it resolved now?",
    });

    expect(res).toEqual({ shouldDrop: false });
  });

  it("still drops human follow-ups mentioning resolution when the bypass is not approved", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: false,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "is it resolved now?",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "is it resolved now?",
    });

    expect(res).toEqual({ shouldDrop: true, reason: "incident-non-root-update" });
  });

  it("still suppresses resolved human thread replies when follow-up bypass is inactive", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      channelConfig: { ...baseConfig, incidentRootOnly: false },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "Status: resolved",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      rawBody: "Status: resolved",
    });

    expect(res).toEqual({ shouldDrop: true, reason: "incident-resolved-update" });
  });

  it("still suppresses resolved human thread replies in non-root-only channels", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: true,
      channelConfig: {
        ...baseConfig,
        incidentRootOnly: false,
        allowHumanThreadFollowups: true,
      },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "Status: resolved",
        ts: "2",
        thread_ts: "1",
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

  it("does not dedupe non-root follow-ups", () => {
    const dedupeStore = new Map<string, number>();
    const first = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: true,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "same follow-up",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      now: 1_000,
      rawBody: "same follow-up",
    });
    const second = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: true,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore,
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "same follow-up",
        ts: "3",
        thread_ts: "1",
        user: "U1",
        type: "message",
      },
      now: 2_000,
      rawBody: "same follow-up",
    });

    expect(first).toEqual({ shouldDrop: false });
    expect(second).toEqual({ shouldDrop: false });
  });

  it("still drops bot thread replies when allowHumanThreadFollowups is enabled", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: false,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "bot update",
        ts: "2",
        thread_ts: "1",
        bot_id: "B1",
        type: "message",
      },
      rawBody: "bot update",
    });

    expect(res).toEqual({ shouldDrop: true, reason: "incident-non-root-update" });
  });

  it("drops bot thread replies with resolved text even with allowHumanThreadFollowups", () => {
    const res = resolveSlackIncidentIngressDrop({
      accountId: "default",
      allowApprovedHumanThreadFollowups: false,
      channelConfig: { ...baseConfig, allowHumanThreadFollowups: true },
      channelId: "C1",
      dedupeStore: new Map(),
      message: {
        channel: "C1",
        channel_type: "channel",
        text: "Status: resolved",
        ts: "2",
        thread_ts: "1",
        bot_id: "B1",
        type: "message",
      },
      rawBody: "Status: resolved",
    });

    expect(res).toEqual({ shouldDrop: true, reason: "incident-resolved-update" });
  });
});
