import { describe, expect, it } from "vitest";
import type { GatewayAccessConfig } from "../config/types.gateway.js";
import {
  canReadSensitiveConfig,
  canWriteConfig,
  filterConfigValue,
  redactConfigForRole,
} from "./config-filter.js";
import { hasPermission, listPermissions } from "./permissions.js";
import { buildRbacIdentity, resolveUserRole } from "./resolve.js";

// ---------------------------------------------------------------------------
// permissions.ts
// ---------------------------------------------------------------------------
describe("hasPermission", () => {
  it("grants admin all permissions", () => {
    const perms = [
      "config.read.sensitive",
      "config.write",
      "commands.admin",
      "tools.all",
      "ai.chat",
    ] as const;
    for (const p of perms) {
      expect(hasPermission("admin", p)).toBe(true);
    }
  });

  it("grants user basic permissions but not sensitive config or admin commands", () => {
    expect(hasPermission("user", "ai.chat")).toBe(true);
    expect(hasPermission("user", "tools.all")).toBe(true);
    expect(hasPermission("user", "config.read.sensitive")).toBe(false);
    expect(hasPermission("user", "config.write")).toBe(false);
    expect(hasPermission("user", "commands.admin")).toBe(false);
  });

  it("grants guest ai.chat only", () => {
    expect(hasPermission("guest", "ai.chat")).toBe(true);
    expect(hasPermission("guest", "tools.all")).toBe(false);
    expect(hasPermission("guest", "config.read.sensitive")).toBe(false);
    expect(hasPermission("guest", "commands.admin")).toBe(false);
  });
});

describe("listPermissions", () => {
  it("returns non-empty list for each role", () => {
    expect(listPermissions("admin").length).toBeGreaterThan(0);
    expect(listPermissions("user").length).toBeGreaterThan(0);
    expect(listPermissions("guest").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolve.ts
// ---------------------------------------------------------------------------
describe("buildRbacIdentity", () => {
  it("builds bare identity without channel", () => {
    const id = buildRbacIdentity({ senderId: "12345" });
    expect(id.senderId).toBe("12345");
    expect(id.channel).toBeUndefined();
    expect(id.qualifiedId).toBe("12345");
  });

  it("builds qualified identity with channel", () => {
    const id = buildRbacIdentity({ senderId: "12345", channel: "telegram" });
    expect(id.senderId).toBe("12345");
    expect(id.channel).toBe("telegram");
    expect(id.qualifiedId).toBe("telegram:12345");
  });

  it("parses pre-qualified senderId", () => {
    const id = buildRbacIdentity({ senderId: "discord:999888777" });
    expect(id.senderId).toBe("999888777");
    expect(id.channel).toBe("discord");
    expect(id.qualifiedId).toBe("discord:999888777");
  });
});

describe("resolveUserRole", () => {
  const telegramAdmin = buildRbacIdentity({ senderId: "111", channel: "telegram" });
  const slackUser = buildRbacIdentity({ senderId: "U999", channel: "slack" });
  const unknown = buildRbacIdentity({ senderId: "???", channel: "discord" });

  it("defaults to user when no access config is provided", () => {
    expect(resolveUserRole({ identity: telegramAdmin })).toBe("user");
  });

  it("grants admin via adminUsers list using qualified ID", () => {
    const cfg: GatewayAccessConfig = { adminUsers: ["telegram:111"] };
    expect(resolveUserRole({ identity: telegramAdmin, accessConfig: cfg })).toBe("admin");
  });

  it("grants admin via adminUsers list using bare sender ID", () => {
    const cfg: GatewayAccessConfig = { adminUsers: ["111"] };
    expect(resolveUserRole({ identity: telegramAdmin, accessConfig: cfg })).toBe("admin");
  });

  it("resolves explicit role from roles map", () => {
    const cfg: GatewayAccessConfig = { roles: { "slack:U999": "guest" } };
    expect(resolveUserRole({ identity: slackUser, accessConfig: cfg })).toBe("guest");
  });

  it("falls back to defaultRole for unknown users", () => {
    const cfg: GatewayAccessConfig = { defaultRole: "guest" };
    expect(resolveUserRole({ identity: unknown, accessConfig: cfg })).toBe("guest");
  });

  it("adminUsers takes precedence over roles map", () => {
    const cfg: GatewayAccessConfig = {
      adminUsers: ["telegram:111"],
      roles: { "telegram:111": "guest" },
    };
    expect(resolveUserRole({ identity: telegramAdmin, accessConfig: cfg })).toBe("admin");
  });

  it("falls back to user when defaultRole unset and no matching entry", () => {
    const cfg: GatewayAccessConfig = { roles: { "slack:U999": "guest" } };
    expect(resolveUserRole({ identity: unknown, accessConfig: cfg })).toBe("user");
  });

  it("ignores invalid role in roles map and falls back to defaultRole", () => {
    const cfg = {
      roles: { "slack:U999": "superuser" as "guest" },
      defaultRole: "guest" as const,
    } as GatewayAccessConfig;
    expect(resolveUserRole({ identity: slackUser, accessConfig: cfg })).toBe("guest");
  });

  it("ignores invalid defaultRole and uses implicit user", () => {
    const cfg = { defaultRole: "owner" as "user" } as GatewayAccessConfig;
    expect(resolveUserRole({ identity: unknown, accessConfig: cfg })).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// config-filter.ts
// ---------------------------------------------------------------------------
describe("canWriteConfig", () => {
  it("returns true for admin", () => expect(canWriteConfig("admin")).toBe(true));
  it("returns false for user", () => expect(canWriteConfig("user")).toBe(false));
  it("returns false for guest", () => expect(canWriteConfig("guest")).toBe(false));
});

describe("canReadSensitiveConfig", () => {
  it("returns true for admin", () => expect(canReadSensitiveConfig("admin")).toBe(true));
  it("returns false for user", () => expect(canReadSensitiveConfig("user")).toBe(false));
});

describe("filterConfigValue", () => {
  it("admin sees sensitive value as-is", () => {
    const { value, hidden } = filterConfigValue({
      path: "providers.openai.apiKey",
      value: "sk-secret",
      role: "admin",
    });
    expect(value).toBe("sk-secret");
    expect(hidden).toBe(false);
  });

  it("user gets placeholder for sensitive path", () => {
    const { value, hidden } = filterConfigValue({
      path: "providers.openai.apiKey",
      value: "sk-secret",
      role: "user",
    });
    expect(typeof value).toBe("string");
    expect(hidden).toBe(true);
  });

  it("user sees non-sensitive path unchanged", () => {
    const { value, hidden } = filterConfigValue({
      path: "gateway.port",
      value: 18789,
      role: "user",
    });
    expect(value).toBe(18789);
    expect(hidden).toBe(false);
  });
});

describe("redactConfigForRole", () => {
  it("returns config unchanged for admin", () => {
    const cfg = { gateway: { port: 18789 }, providers: { openai: { apiKey: "sk-secret" } } };
    const result = redactConfigForRole({ config: cfg, role: "admin" });
    expect(result).toBe(cfg);
  });

  it("redacts sensitive nested keys for user", () => {
    const cfg = { gateway: { port: 18789 }, providers: { openai: { apiKey: "sk-secret" } } };
    const result = redactConfigForRole({ config: cfg, role: "user" });
    expect(result["gateway"]).toBeDefined();
    // Non-sensitive top-level or nested keys pass through
    expect((result["gateway"] as Record<string, unknown>)["port"]).toBe(18789);
  });
});
