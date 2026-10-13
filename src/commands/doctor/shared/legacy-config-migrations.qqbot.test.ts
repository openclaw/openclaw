import { describe, expect, it, vi } from "vitest";
import { getRecord } from "../../../config/legacy.shared.js";
import { widenOfficialExternalChannelSecretSchema } from "../../../config/official-external-channel-secret-schema.js";
import { validateJsonSchemaValue } from "../../../plugins/schema-validator.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { maybeRepairOpenPolicyAllowFrom } from "./open-policy-allowfrom.js";

const locked = ["openclaw:approval-disabled"];

function migrate(raw: Record<string, unknown>) {
  const config = structuredClone(raw);
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_QQBOT) {
    migration.apply(config, changes);
  }
  return { config, changes, qqbot: getRecord(getRecord(config.channels)?.qqbot) };
}

function migrateChannel(qqbot: Record<string, unknown>) {
  return migrate({ channels: { qqbot } });
}

describe("Tencent QQBot 2.0 config migrations", () => {
  it("keeps environment credentials private and approvals locked through later repairs", () => {
    vi.stubEnv("QQBOT_APP_ID", "environment-app");
    vi.stubEnv("QQBOT_CLIENT_SECRET", "placeholder");
    try {
      const { config, qqbot } = migrate({});
      expect(qqbot).toEqual({ enabled: true, dmPolicy: "open", allowFrom: locked });
      expect(JSON.stringify(config)).not.toContain("placeholder");
      const repaired = maybeRepairOpenPolicyAllowFrom(config);
      expect(repaired).toEqual({ config, changes: [] });
      expect(maybeRepairOpenPolicyAllowFrom(repaired.config)).toEqual(repaired);
      const schema = widenOfficialExternalChannelSecretSchema({
        channelId: "qqbot",
        schema: { type: "object", additionalProperties: true },
      });
      expect(
        validateJsonSchemaValue({
          cacheKey: "qqbot-doctor-order-regression",
          schema: schema ?? {},
          value: qqbot,
        }).ok,
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allocates distinct file SecretRefs for root and colliding account aliases", () => {
    const { config, qqbot } = migrateChannel({
      clientSecretFile: "/run/secrets/root",
      accounts: {
        ops: { clientSecretFile: "/run/secrets/ops" },
        Ops: { clientSecretFile: "/run/secrets/other" },
      },
    });
    expect(qqbot).toMatchObject({
      clientSecret: { source: "file", provider: "qqbot-client-secret", id: "value" },
      accounts: {
        ops: { clientSecret: { source: "file", provider: "qqbot-ops-client-secret", id: "value" } },
        Ops: {
          clientSecret: { source: "file", provider: "qqbot-ops-client-secret-2", id: "value" },
        },
      },
    });
    expect(config).toHaveProperty("secrets.providers", {
      "qqbot-client-secret": { source: "file", path: "/run/secrets/root", mode: "singleValue" },
      "qqbot-ops-client-secret": { source: "file", path: "/run/secrets/ops", mode: "singleValue" },
      "qqbot-ops-client-secret-2": {
        source: "file",
        path: "/run/secrets/other",
        mode: "singleValue",
      },
    });
    expect(JSON.stringify(config)).not.toContain("clientSecretFile");
  });

  it("intersects normalized approvers with each account's chat access", () => {
    const { config, qqbot } = migrateChannel({
      allowFrom: ["chat-admin", "qqbot:shared-admin"],
      execApprovals: { approvers: ["approval-admin", "QQBot:SHARED-ADMIN"] },
      accounts: {
        denied: { dmPolicy: "allowlist", allowFrom: [], execApprovals: { approvers: ["admin"] } },
        open: { allowFrom: ["*"], execApprovals: { approvers: ["admin"] } },
      },
    });
    expect(qqbot).toMatchObject({
      allowFrom: ["SHARED-ADMIN"],
      accounts: {
        denied: { dmPolicy: "allowlist", allowFrom: locked },
        open: { dmPolicy: "open", allowFrom: ["ADMIN"] },
      },
    });
    expect(JSON.stringify(config)).not.toContain("execApprovals");
  });

  it("reconciles command operators with each account without promoting chat-only users", () => {
    const raw = {
      commands: { allowFrom: { qqbot: ["operator"] } },
      channels: {
        qqbot: {
          allowFrom: ["operator", "chat-only"],
          accounts: { denied: { dmPolicy: "allowlist", allowFrom: ["chat-only"] } },
        },
      },
    };
    const operatorRule = LEGACY_CONFIG_MIGRATIONS_QQBOT[0]?.legacyRules?.find((rule) =>
      rule.message.includes("commands.allowFrom approval operators"),
    );
    expect(operatorRule?.match?.(raw.channels.qqbot, raw)).toBe(true);
    const { config, qqbot } = migrate(raw);
    expect(qqbot).toMatchObject({
      allowFrom: ["OPERATOR"],
      accounts: { denied: { dmPolicy: "allowlist", allowFrom: locked } },
    });
    expect(operatorRule?.match?.(qqbot, config)).toBe(false);
    expect(migrate(config).changes).toEqual([]);
  });

  it("flattens default-account overrides without opening an empty allowlist", () => {
    const { qqbot } = migrateChannel({
      dmPolicy: "open",
      allowFrom: [],
      defaultAccount: "default",
      accounts: { default: { appId: "default-app", dmPolicy: "allowlist" } },
    });
    expect(qqbot).toEqual({ appId: "default-app", dmPolicy: "allowlist", allowFrom: locked });
  });

  it("selects the lowercase named default without closing wildcard DMs", () => {
    const { qqbot } = migrateChannel({
      defaultAccount: "Ops",
      accounts: {
        Ops: { appId: "uppercase-app", allowFrom: ["qqbot:upper"] },
        ops: { appId: "lowercase-app", dmPolicy: "allowlist", allowFrom: ["*", "QQBot:ops-user"] },
      },
    });
    expect(Object.keys(getRecord(qqbot?.accounts) ?? {})).toEqual(["ops", "Ops"]);
    expect(qqbot).not.toHaveProperty("defaultAccount");
    expect(qqbot).toHaveProperty("accounts", {
      ops: { appId: "lowercase-app", dmPolicy: "open", allowFrom: ["OPS-USER"] },
      Ops: { appId: "uppercase-app", allowFrom: ["UPPER"] },
    });
  });

  it("fails closed when integer keys prevent preserving the named default", () => {
    const { qqbot } = migrateChannel({
      defaultAccount: "ops",
      accounts: {
        "123": { appId: "numeric-app", allowFrom: ["NUMERIC"] },
        ops: { appId: "ops-app", allowFrom: ["OPS"] },
      },
    });
    expect(qqbot?.defaultAccount).toBe("ops");
    expect(Object.keys(getRecord(qqbot?.accounts) ?? {})).toEqual(["123", "ops"]);
  });

  it("locks unrepresentable approvals while preserving a representable account fallback", () => {
    const { qqbot } = migrateChannel({
      allowFrom: ["*"],
      execApprovals: { enabled: false, approvers: ["admin"] },
      accounts: {
        filtered: { execApprovals: { approvers: ["admin"], agentFilter: ["ops"] } },
        fallback: { allowFrom: ["admin"], execApprovals: { enabled: "auto" } },
      },
    });
    expect(qqbot).toMatchObject({
      allowFrom: locked,
      dmPolicy: "open",
      accounts: {
        filtered: { allowFrom: locked, dmPolicy: "open" },
        fallback: { allowFrom: ["ADMIN"] },
      },
    });
  });

  it("maps native streaming switches to their effective wire behavior", () => {
    const { qqbot } = migrateChannel({
      streaming: { mode: "off", c2cStreamApi: true },
      accounts: { staticOnly: { streaming: { mode: "partial", nativeTransport: false } } },
    });
    expect(qqbot?.streaming).toEqual({ mode: "partial" });
    expect(qqbot).toHaveProperty("accounts.staticOnly.streaming", { mode: "off" });
  });

  it("maps group tool policies without broadening existing restrictions", () => {
    const { qqbot } = migrateChannel({
      groups: {
        full: { tools: { allow: [] } },
        wildcard: { tools: { allow: ["*"] } },
        empty: { tools: {} },
        emptyDeny: { tools: { deny: [] } },
        restricted: { tools: { deny: ["write", "exec", "read"] } },
        none: { tools: { deny: ["*"] } },
        custom: { tools: { allow: ["read"] } },
        senderSpecific: { toolsBySender: { admin: { allow: [] } } },
        coexist: { toolPolicy: "full", tools: { deny: ["*"] } },
      },
    });
    expect(qqbot?.groups).toEqual({
      full: { toolPolicy: "full" },
      wildcard: { toolPolicy: "full" },
      empty: { toolPolicy: "full" },
      emptyDeny: { toolPolicy: "full" },
      restricted: { toolPolicy: "restricted" },
      none: { toolPolicy: "none" },
      custom: { toolPolicy: "none" },
      senderSpecific: { toolPolicy: "none" },
      coexist: { toolPolicy: "none" },
    });
  });

  it("removes command levels and locks only accounts with restrictive group commands", () => {
    const { config, qqbot } = migrateChannel({
      groups: { public: { commandLevel: "all" }, sensitive: { commandLevel: "safety" } },
      accounts: {
        default: { groupPolicy: "open" },
        unrestricted: { groups: { "*": { commandLevel: "all" } } },
        strict: { groups: { "*": { commandLevel: "strict" } } },
      },
    });
    expect(qqbot).toMatchObject({
      groupPolicy: "disabled",
      groups: { public: {}, sensitive: {} },
      accounts: {
        unrestricted: { groups: { "*": {} } },
        strict: { groupPolicy: "disabled", groups: { "*": {} } },
      },
    });
    expect(qqbot).not.toHaveProperty("accounts.unrestricted.groupPolicy");
    expect(JSON.stringify(config)).not.toContain("commandLevel");
  });
});
