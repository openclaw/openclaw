import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildChannelAccountBindings,
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
} from "./bindings.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

describe("route binding account helpers", () => {
  it.each([undefined, "", "  "])("includes implicit account %j in diagnostics", (accountId) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId } }],
    };
    expect(listBoundAccountIds(cfg, "telegram")).toEqual(["default"]);
    expect(buildChannelAccountBindings(cfg)).toEqual(
      new Map([["telegram", new Map([["main", ["default"]]])]]),
    );
  });

  it("keeps implicit bindings out of outbound account selection", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      channels: { telegram: { defaultAccount: "work" } },
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
    };
    expect(resolveDefaultAgentBoundAccountId(cfg, "telegram")).toBeNull();
    expect(
      resolveFirstBoundAccountId({ cfg, channelId: "telegram", agentId: "main" }),
    ).toBeUndefined();

    cfg.bindings = [
      { agentId: "main", match: { channel: "telegram" } },
      { agentId: "main", match: { channel: "telegram", accountId: "alerts" } },
    ];
    expect(resolveDefaultAgentBoundAccountId(cfg, "telegram")).toBe("alerts");
    expect(resolveFirstBoundAccountId({ cfg, channelId: "telegram", agentId: "main" })).toBe(
      "alerts",
    );
  });

  it("preserves account order and agent scope while deduplicating implicit defaults", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, support: {} } },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "work" } },
        { agentId: "main", match: { channel: "telegram" } },
        { agentId: "main", match: { channel: "telegram", accountId: "default" } },
        {
          agentId: "support",
          match: { channel: "telegram", peer: { kind: "group", id: "group-a" } },
        },
        { agentId: "support", match: { channel: "telegram", accountId: "*" } },
        { agentId: "support", match: { channel: "slack", accountId: "alerts" } },
      ],
    };
    expect(listBoundAccountIds(cfg, "telegram")).toEqual(["default", "work"]);
    expect(buildChannelAccountBindings(cfg).get("telegram")).toEqual(
      new Map([
        ["main", ["work", "default"]],
        ["support", ["default"]],
      ]),
    );
    expect(resolveDefaultAgentBoundAccountId(cfg, "telegram")).toBeNull();
  });
});
