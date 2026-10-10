import { describe, expect, it } from "vitest";
import {
  patchAccountBinding,
  readChannelAccounts,
  readChannelRouteBindings,
  readAgentIds,
  resolveAccountAgent,
} from "./view.routing.ts";

const configWith = (bindings: unknown[], accounts?: Record<string, unknown>) => ({
  bindings,
  agents: { entries: { main: {}, test: {} } },
  channels: {
    "dingtalk-connector": {
      accounts: accounts ?? { main: {}, "test-robot": {} },
    },
  },
});

describe("channel agent routing helpers", () => {
  it("lists explicit accounts and falls back to the canonical default", () => {
    expect(readChannelAccounts(configWith([]), "dingtalk-connector")).toEqual([
      "main",
      "test-robot",
    ]);
    // Runtime default row id (src/routing/account-id.ts DEFAULT_ACCOUNT_ID).
    expect(readChannelAccounts(configWith([], {}), "dingtalk-connector")).toEqual(["default"]);
    expect(readChannelAccounts(null, "dingtalk-connector")).toEqual(["default"]);
  });

  it("lists agent ids with a main fallback", () => {
    expect(readAgentIds(configWith([]))).toEqual(["main", "test"]);
    expect(readAgentIds({ agents: {} })).toEqual(["main"]);
    expect(readAgentIds(null)).toEqual(["main"]);
  });

  it("collects only account-level route bindings for the channel", () => {
    const bindings = [
      { agentId: "main", match: { channel: "dingtalk-connector", accountId: "*" } },
      { agentId: "x", match: { channel: "telegram", accountId: "*" } },
      { type: "acp", agentId: "y", match: { channel: "dingtalk-connector" } },
      {
        agentId: "z",
        match: { channel: "dingtalk-connector", peer: { kind: "direct", id: "p" } },
      },
    ];
    const collected = readChannelRouteBindings(configWith(bindings), "dingtalk-connector");
    expect(collected).toHaveLength(1);
    expect(collected[0]?.agentId).toBe("main");
  });

  it("resolves bindings with an omitted account id to the default row", () => {
    // Runtime contract: { match: { channel } } without accountId targets the
    // default account — the editor must surface it on the default row.
    const bindings = [{ agentId: "support", match: { channel: "telegram" } }];
    expect(resolveAccountAgent(bindings, "default")).toEqual({
      agentId: "support",
      viaWildcard: false,
    });
    expect(resolveAccountAgent(bindings, "main").agentId).toBeNull();
  });

  it("patching one row preserves every other binding byte-for-byte", () => {
    const scopedBinding = {
      agentId: "main",
      comment: "owned by ops",
      match: { channel: "dingtalk-connector", accountId: "main" },
      session: { dmScope: "shared", groupScope: "shared" },
    };
    const telegramBinding = {
      agentId: "support",
      match: { channel: "telegram", accountId: "*" },
    };
    const omittedDefault = { agentId: "helper", match: { channel: "other-channel" } };
    const peerBinding = {
      agentId: "peer-agent",
      match: { channel: "dingtalk-connector", peer: { kind: "direct", id: "p" } },
    };
    const config = configWith([scopedBinding, telegramBinding, omittedDefault, peerBinding]);

    const next = patchAccountBinding({
      configValue: config,
      channelId: "dingtalk-connector",
      accountId: "test-robot",
      agentId: "test",
    });

    // Only the new row's binding is added; untouched bindings keep identity.
    expect(next).toHaveLength(5);
    expect(next[0]).toBe(scopedBinding);
    expect(next[1]).toBe(telegramBinding);
    expect(next[2]).toBe(omittedDefault);
    expect(next[3]).toBe(peerBinding);
    expect(next[4]).toEqual({
      agentId: "test",
      match: { channel: "dingtalk-connector", accountId: "test-robot" },
    });
  });

  it("changing an agent keeps that binding's non-agent fields and match shape", () => {
    const scoped = {
      agentId: "main",
      comment: "owned by ops",
      match: { channel: "dingtalk-connector", accountId: "main" },
      session: { dmScope: "shared" },
    };
    const config = configWith([scoped]);
    const next = patchAccountBinding({
      configValue: config,
      channelId: "dingtalk-connector",
      accountId: "main",
      agentId: "test",
    });
    expect(next[0]).toEqual({ ...scoped, agentId: "test" });
    // The original binding object is not mutated.
    expect(scoped.agentId).toBe("main");
  });

  it("patches the default row through an omitted-accountId binding", () => {
    const omitted = { agentId: "helper", match: { channel: "telegram" } };
    const next = patchAccountBinding({
      configValue: { bindings: [omitted] },
      channelId: "telegram",
      accountId: "default",
      agentId: "test",
    });
    // Recognized as the default row: agent swapped in place, match untouched.
    expect(next).toEqual([{ ...omitted, agentId: "test" }]);
  });

  it("clearing a row removes only that row's binding", () => {
    const keep = {
      agentId: "main",
      match: { channel: "dingtalk-connector", accountId: "main" },
      session: { dmScope: "shared" },
    };
    const remove = {
      agentId: "test",
      match: { channel: "dingtalk-connector", accountId: "test-robot" },
    };
    const next = patchAccountBinding({
      configValue: configWith([keep, remove]),
      channelId: "dingtalk-connector",
      accountId: "test-robot",
      agentId: "",
    });
    expect(next).toEqual([keep]);
  });

  it("treats empty scope constraints as account-level", () => {
    // Runtime normalizes roles: [] and blank guild/team ids to absent
    // constraints — the binding stays account-level and must be matched,
    // not skipped in favor of appending an ineffective duplicate.
    const binding = {
      agentId: "main",
      match: {
        channel: "dingtalk-connector",
        accountId: "biz",
        roles: [],
        guildId: "",
        teamId: " ",
      },
    };
    const collected = readChannelRouteBindings({ bindings: [binding] }, "dingtalk-connector");
    expect(collected).toHaveLength(1);
    const next = patchAccountBinding({
      configValue: { bindings: [binding] },
      channelId: "dingtalk-connector",
      accountId: "biz",
      agentId: "test",
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.agentId).toBe("test");
  });

  it("matches bindings whose channel id carries padding or case", () => {
    const binding = {
      agentId: "main",
      match: { channel: " Telegram ", accountId: "*" },
    };
    expect(readChannelRouteBindings({ bindings: [binding] }, "telegram")).toHaveLength(1);
  });

  it("resolves a row whose configured key is mixed-case", () => {
    // Configured keys keep authored spelling: a "BIZ" row must resolve its
    // canonical "biz" binding, not fall through to Not set / wildcard.
    const binding = {
      agentId: "main",
      match: { channel: "dingtalk-connector", accountId: "biz" },
    };
    expect(resolveAccountAgent([binding], "BIZ").agentId).toBe("main");
  });

  it("dedupes roster rows that differ only by canonical identity", () => {
    expect(readChannelAccounts(configWith([]), "dingtalk-connector", ["MAIN"])).toEqual([
      "main",
      "test-robot",
    ]);
  });

  it("recognizes a padded wildcard binding as the channel-wide fallback", () => {
    const binding = {
      agentId: "main",
      match: { channel: "dingtalk-connector", accountId: " * " },
    };
    expect(resolveAccountAgent([binding], "test-robot")).toEqual({
      agentId: "main",
      viaWildcard: true,
    });
  });

  it("matches padded and mixed-case account ids to their existing binding", () => {
    // Runtime canonicalizes account ids (trim + lowercase), so "BIZ" and
    // " biz " are the same account as "biz": the editor must resolve the
    // existing binding instead of appending a duplicate that never wins.
    const binding = {
      agentId: "main",
      match: { channel: "dingtalk-connector", accountId: " BIZ " },
      session: { dmScope: "per-peer" },
    };
    expect(resolveAccountAgent([binding], "biz").agentId).toBe("main");
    const next = patchAccountBinding({
      configValue: { bindings: [binding] },
      channelId: "dingtalk-connector",
      accountId: "biz",
      agentId: "test",
    });
    expect(next).toHaveLength(1);
    // Authored match text preserved; only the agent changed.
    expect(next[0]?.match).toEqual({ channel: "dingtalk-connector", accountId: " BIZ " });
    expect(next[0]?.agentId).toBe("test");
  });

  it("unions configured accounts with the runtime account roster", () => {
    // Runtime keeps an implicit default account active alongside named
    // accounts; the editor must offer that row too.
    expect(readChannelAccounts(configWith([]), "dingtalk-connector", ["default"])).toEqual([
      "main",
      "test-robot",
      "default",
    ]);
    // Roster ids dedupe against configured keys.
    expect(readChannelAccounts(configWith([]), "dingtalk-connector", ["main"])).toEqual([
      "main",
      "test-robot",
    ]);
  });

  it("inserts new specific bindings ahead of the channel wildcard", () => {
    const wildcard = {
      agentId: "main",
      match: { channel: "dingtalk-connector", accountId: "*" },
    };
    const next = patchAccountBinding({
      configValue: configWith([wildcard]),
      channelId: "dingtalk-connector",
      accountId: "main",
      agentId: "test",
    });
    expect(next[0]?.match).toEqual({ channel: "dingtalk-connector", accountId: "main" });
    expect(next[1]).toBe(wildcard);
  });
});
