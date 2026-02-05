import { describe, expect, it } from "vitest";
import {
  listBindings,
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
  buildChannelAccountBindings,
  resolvePreferredAccountId,
} from "./bindings.js";

describe("listBindings", () => {
  it("returns empty array when cfg.bindings is undefined", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = {} as any;
    expect(listBindings(cfg)).toEqual([]);
  });

  it("returns empty array when cfg.bindings is not an array", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { bindings: "not-an-array" } as any;
    expect(listBindings(cfg)).toEqual([]);
  });

  it("returns bindings array when present", () => {
    const bindings = [{ agentId: "main", match: { channel: "telegram", accountId: "acct1" } }];
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { bindings } as any;
    expect(listBindings(cfg)).toBe(bindings);
  });
});

describe("listBoundAccountIds", () => {
  it("returns empty for empty channelId", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { bindings: [] } as any;
    expect(listBoundAccountIds(cfg, "")).toEqual([]);
  });

  it("returns sorted unique account IDs for matching channel", () => {
    const cfg = {
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "zulu" } },
        { agentId: "main", match: { channel: "telegram", accountId: "alpha" } },
        { agentId: "bot2", match: { channel: "telegram", accountId: "alpha" } },
        { agentId: "main", match: { channel: "discord", accountId: "other" } },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = listBoundAccountIds(cfg, "telegram");
    expect(result).toEqual(["alpha", "zulu"]);
  });

  it("skips wildcard '*' accountIds", () => {
    const cfg = {
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "*" } },
        { agentId: "main", match: { channel: "telegram", accountId: "real" } },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = listBoundAccountIds(cfg, "telegram");
    expect(result).toEqual(["real"]);
  });

  it("skips invalid/null bindings", () => {
    const cfg = {
      bindings: [
        null,
        undefined,
        "bad",
        { agentId: "main", match: null },
        { agentId: "main", match: { channel: "telegram", accountId: "valid" } },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = listBoundAccountIds(cfg, "telegram");
    expect(result).toEqual(["valid"]);
  });
});

describe("resolveDefaultAgentBoundAccountId", () => {
  it("returns null for empty channelId", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { bindings: [] } as any;
    expect(resolveDefaultAgentBoundAccountId(cfg, "")).toBeNull();
  });

  it("returns account for default agent matching channel", () => {
    const cfg = {
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "mybot" } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = resolveDefaultAgentBoundAccountId(cfg, "telegram");
    expect(result).toBe("mybot");
  });

  it("returns null when no binding matches", () => {
    const cfg = {
      bindings: [{ agentId: "main", match: { channel: "discord", accountId: "bot1" } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    expect(resolveDefaultAgentBoundAccountId(cfg, "telegram")).toBeNull();
  });
});

describe("buildChannelAccountBindings", () => {
  it("builds nested map from bindings", () => {
    const cfg = {
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "bot1" } },
        { agentId: "main", match: { channel: "telegram", accountId: "bot2" } },
        { agentId: "helper", match: { channel: "discord", accountId: "disc1" } },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const map = buildChannelAccountBindings(cfg);

    expect(map.size).toBe(2);

    const telegramAgents = map.get("telegram");
    expect(telegramAgents).toBeDefined();
    expect(telegramAgents!.get("main")).toEqual(["bot1", "bot2"]);

    const discordAgents = map.get("discord");
    expect(discordAgents).toBeDefined();
    expect(discordAgents!.get("helper")).toEqual(["disc1"]);
  });

  it("handles empty bindings", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { bindings: [] } as any;
    const map = buildChannelAccountBindings(cfg);
    expect(map.size).toBe(0);
  });
});

describe("resolvePreferredAccountId", () => {
  it("returns first bound account when available", () => {
    const result = resolvePreferredAccountId({
      accountIds: ["a", "b"],
      defaultAccountId: "fallback",
      boundAccounts: ["bound1", "bound2"],
    });
    expect(result).toBe("bound1");
  });

  it("returns default account when no bound accounts", () => {
    const result = resolvePreferredAccountId({
      accountIds: ["a", "b"],
      defaultAccountId: "fallback",
      boundAccounts: [],
    });
    expect(result).toBe("fallback");
  });
});
