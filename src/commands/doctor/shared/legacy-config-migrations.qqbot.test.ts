import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecord } from "../../../config/legacy.shared.js";
import { widenOfficialExternalChannelSecretSchema } from "../../../config/official-external-channel-secret-schema.js";
import { validateJsonSchemaValue } from "../../../plugins/schema-validator.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { maybeRepairOpenPolicyAllowFrom } from "./open-policy-allowfrom.js";

const locked = ["openclaw:approval-disabled"];

afterEach(() => vi.unstubAllEnvs());

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
    const validation = validateJsonSchemaValue({
      cacheKey: "qqbot-doctor-order-regression",
      schema: schema ?? {},
      value: qqbot,
    });
    expect(validation.ok).toBe(true);
  });

  it("allocates distinct file SecretRefs for root and colliding account aliases", () => {
    const secrets = [
      ["clientSecret", "qqbot-client-secret", "root"],
      ["accounts.ops.clientSecret", "qqbot-ops-client-secret", "ops"],
      ["accounts.Ops.clientSecret", "qqbot-ops-client-secret-2", "other"],
    ] as const;
    const { config, qqbot } = migrateChannel({
      clientSecretFile: "/run/secrets/root",
      accounts: {
        ops: { clientSecretFile: "/run/secrets/ops" },
        Ops: { clientSecretFile: "/run/secrets/other" },
      },
    });
    for (const [key, provider] of secrets) {
      expect(qqbot).toHaveProperty(key, { source: "file", provider, id: "value" });
    }
    const providers = Object.fromEntries(
      secrets.map(([, provider, name]) => [
        provider,
        { source: "file", path: `/run/secrets/${name}`, mode: "singleValue" },
      ]),
    );
    expect(config).toHaveProperty("secrets.providers", providers);
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

  it("locks unrepresentable approvals while preserving a representable account fallback", () => {
    const { config, qqbot } = migrateChannel({
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
    expect(JSON.stringify(config)).not.toContain("execApprovals");
  });

  it("reconciles command operators with each account without promoting chat-only users", () => {
    const channel = {
      allowFrom: ["operator", "chat-only"],
      accounts: { denied: { dmPolicy: "allowlist", allowFrom: ["chat-only"] } },
    };
    const raw = {
      commands: { allowFrom: { qqbot: ["operator"] } },
      channels: { qqbot: channel },
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
      accounts: { "123": {}, ops: {} },
    });
    expect(qqbot?.defaultAccount).toBe("ops");
    expect(Object.keys(getRecord(qqbot?.accounts) ?? {})).toEqual(["123", "ops"]);
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
    const groups = [
      ["full", { tools: { allow: [] } }, "full"],
      ["wildcard", { tools: { allow: ["*"] } }, "full"],
      ["empty", { tools: {} }, "full"],
      ["emptyDeny", { tools: { deny: [] } }, "full"],
      ["restricted", { tools: { deny: ["write", "exec", "read"] } }, "restricted"],
      ["none", { tools: { deny: ["*"] } }, "none"],
      ["custom", { tools: { allow: ["read"] } }, "none"],
      ["senderSpecific", { toolsBySender: { admin: { allow: [] } } }, "none"],
      ["coexist", { toolPolicy: "full", tools: { deny: ["*"] } }, "none"],
    ] as const;
    const { qqbot } = migrateChannel({
      groups: Object.fromEntries(groups.map(([id, input]) => [id, input])),
    });
    expect(qqbot?.groups).toEqual(
      Object.fromEntries(groups.map(([id, , toolPolicy]) => [id, { toolPolicy }])),
    );
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
