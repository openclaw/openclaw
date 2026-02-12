import { describe, expect, it } from "vitest";
import { listBoundAgentIds } from "./bindings.js";

describe("listBoundAgentIds", () => {
  it("returns only agents bound to the requested channel/account", () => {
    const cfg = {
      agents: { list: [{ id: "main" }, { id: "boxed" }, { id: "research" }] },
      bindings: [
        { agentId: "main", match: { channel: "discord", accountId: "default" } },
        { agentId: "boxed", match: { channel: "telegram", accountId: "default" } },
        { agentId: "research", match: { channel: "discord", accountId: "work" } },
      ],
    };

    expect(listBoundAgentIds({ cfg, channelId: "discord", accountId: "default" })).toEqual([
      "main",
    ]);
    expect(listBoundAgentIds({ cfg, channelId: "discord", accountId: "work" })).toEqual([
      "research",
    ]);
  });

  it("treats missing binding accountId as default only", () => {
    const cfg = {
      agents: { list: [{ id: "main" }, { id: "other" }] },
      bindings: [
        { agentId: "main", match: { channel: "discord" } },
        { agentId: "other", match: { channel: "discord", accountId: "work" } },
      ],
    };

    expect(listBoundAgentIds({ cfg, channelId: "discord", accountId: "default" })).toEqual([
      "main",
    ]);
    expect(listBoundAgentIds({ cfg, channelId: "discord", accountId: "work" })).toEqual(["other"]);
  });

  it("supports accountId=* bindings and falls back to default agent when none match", () => {
    const cfg = {
      agents: { list: [{ id: "main" }, { id: "any" }] },
      bindings: [{ agentId: "any", match: { channel: "discord", accountId: "*" } }],
    };

    expect(listBoundAgentIds({ cfg, channelId: "discord", accountId: "default" })).toEqual(["any"]);
    expect(listBoundAgentIds({ cfg, channelId: "discord", accountId: "work" })).toEqual(["any"]);
    expect(listBoundAgentIds({ cfg, channelId: "slack", accountId: "default" })).toEqual(["main"]);
  });
});
