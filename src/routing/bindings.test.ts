import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOwningAgentIdForChannelAccount } from "./bindings.js";

describe("resolveOwningAgentIdForChannelAccount", () => {
  it("prefers exact unscoped account bindings", () => {
    const cfg = {
      bindings: [
        {
          agentId: "ops-agent",
          match: { channel: "discord", accountId: "ops" },
        },
        {
          agentId: "fallback-agent",
          match: { channel: "discord", accountId: "*" },
        },
      ],
    } as OpenClawConfig;

    expect(resolveOwningAgentIdForChannelAccount(cfg, "discord", "ops")).toBe("ops-agent");
  });

  it("ignores scoped bindings when resolving sender ownership", () => {
    const cfg = {
      bindings: [
        {
          agentId: "scoped-agent",
          match: { channel: "discord", accountId: "ops", peer: { kind: "user", id: "123" } },
        },
        {
          agentId: "ops-agent",
          match: { channel: "discord", accountId: "ops" },
        },
      ],
    } as OpenClawConfig;

    expect(resolveOwningAgentIdForChannelAccount(cfg, "discord", "ops")).toBe("ops-agent");
  });

  it("falls back to an unscoped channel wildcard when no exact account binding exists", () => {
    const cfg = {
      bindings: [
        {
          agentId: "fallback-agent",
          match: { channel: "matrix", accountId: "*" },
        },
      ],
    } as OpenClawConfig;

    expect(resolveOwningAgentIdForChannelAccount(cfg, "matrix", "ops")).toBe("fallback-agent");
  });

  it("treats missing account bindings as the default account", () => {
    const cfg = {
      bindings: [
        {
          agentId: "default-agent",
          match: { channel: "discord" },
        },
      ],
    } as OpenClawConfig;

    expect(resolveOwningAgentIdForChannelAccount(cfg, "discord", "default")).toBe("default-agent");
  });

  it("falls back to the default agent when no binding matches", () => {
    const cfg = {
      agents: {
        list: [{ id: "default-agent", default: true, model: "gpt-5" }],
      },
    } as OpenClawConfig;

    expect(resolveOwningAgentIdForChannelAccount(cfg, "discord", "ops")).toBe("default-agent");
  });

  it("canonicalizes stale binding agent ids to the configured default agent", () => {
    const cfg = {
      agents: {
        list: [{ id: "default-agent", default: true, model: "gpt-5" }],
      },
      bindings: [
        {
          agentId: "removed-agent",
          match: { channel: "discord", accountId: "ops" },
        },
      ],
    } as OpenClawConfig;

    expect(resolveOwningAgentIdForChannelAccount(cfg, "discord", "ops")).toBe("default-agent");
  });
});
