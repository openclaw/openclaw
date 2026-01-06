import { describe, expect, test } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveAgentRoute } from "./resolve-route.js";

describe("resolveAgentRoute", () => {
  test("defaults to main/default when no bindings exist", () => {
    const cfg: ClawdbotConfig = {};
    const route = resolveAgentRoute({
      cfg,
      provider: "whatsapp",
      accountId: null,
      peer: { kind: "dm", id: "+15551234567" },
    });
    expect(route.agentId).toBe("main");
    expect(route.accountId).toBe("default");
    expect(route.sessionKey).toBe("agent:main:main");
    expect(route.matchedBy).toBe("default");
  });

  test("peer binding wins over account binding", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        bindings: [
          {
            agentId: "a",
            match: {
              provider: "whatsapp",
              accountId: "biz",
              peer: { kind: "dm", id: "+1000" },
            },
          },
          {
            agentId: "b",
            match: { provider: "whatsapp", accountId: "biz" },
          },
        ],
      },
    };
    const route = resolveAgentRoute({
      cfg,
      provider: "whatsapp",
      accountId: "biz",
      peer: { kind: "dm", id: "+1000" },
    });
    expect(route.agentId).toBe("a");
    expect(route.sessionKey).toBe("agent:a:main");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("discord channel peer binding wins over guild binding", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        bindings: [
          {
            agentId: "chan",
            match: {
              provider: "discord",
              accountId: "default",
              peer: { kind: "channel", id: "c1" },
            },
          },
          {
            agentId: "guild",
            match: {
              provider: "discord",
              accountId: "default",
              guildId: "g1",
            },
          },
        ],
      },
    };
    const route = resolveAgentRoute({
      cfg,
      provider: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "c1" },
      guildId: "g1",
    });
    expect(route.agentId).toBe("chan");
    expect(route.sessionKey).toBe("agent:chan:discord:channel:c1");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("guild binding wins over account binding when peer not bound", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        bindings: [
          {
            agentId: "guild",
            match: {
              provider: "discord",
              accountId: "default",
              guildId: "g1",
            },
          },
          {
            agentId: "acct",
            match: { provider: "discord", accountId: "default" },
          },
        ],
      },
    };
    const route = resolveAgentRoute({
      cfg,
      provider: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "c1" },
      guildId: "g1",
    });
    expect(route.agentId).toBe("guild");
    expect(route.matchedBy).toBe("binding.guild");
  });

  test("missing accountId in binding matches default account only", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        bindings: [{ agentId: "defaultAcct", match: { provider: "whatsapp" } }],
      },
    };

    const defaultRoute = resolveAgentRoute({
      cfg,
      provider: "whatsapp",
      accountId: undefined,
      peer: { kind: "dm", id: "+1000" },
    });
    expect(defaultRoute.agentId).toBe("defaultAcct");
    expect(defaultRoute.matchedBy).toBe("binding.account");

    const otherRoute = resolveAgentRoute({
      cfg,
      provider: "whatsapp",
      accountId: "biz",
      peer: { kind: "dm", id: "+1000" },
    });
    expect(otherRoute.agentId).toBe("main");
  });

  test("accountId=* matches any account as a provider fallback", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        bindings: [
          {
            agentId: "any",
            match: { provider: "whatsapp", accountId: "*" },
          },
        ],
      },
    };
    const route = resolveAgentRoute({
      cfg,
      provider: "whatsapp",
      accountId: "biz",
      peer: { kind: "dm", id: "+1000" },
    });
    expect(route.agentId).toBe("any");
    expect(route.matchedBy).toBe("binding.provider");
  });

  test("defaultAgentId is used when no binding matches", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        defaultAgentId: "home",
        agents: { home: { workspace: "~/clawd-home" } },
      },
    };
    const route = resolveAgentRoute({
      cfg,
      provider: "whatsapp",
      accountId: "biz",
      peer: { kind: "dm", id: "+1000" },
    });
    expect(route.agentId).toBe("home");
    expect(route.sessionKey).toBe("agent:home:main");
  });
});
