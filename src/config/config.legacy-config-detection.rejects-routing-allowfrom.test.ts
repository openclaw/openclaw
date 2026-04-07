import { describe, expect, it } from "vitest";
import { IMessageConfigSchema } from "../../extensions/imessage/config-api.js";
import { SignalConfigSchema } from "../../extensions/signal/config-api.js";
import { TelegramConfigSchema } from "../../extensions/telegram/config-api.js";
import { WhatsAppConfigSchema } from "../../extensions/whatsapp/config-api.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { validateConfigObject } from "./validation.js";
import {
  DiscordConfigSchema,
  MSTeamsConfigSchema,
  SlackConfigSchema,
} from "./zod-schema.providers-core.js";

function expectSchemaInvalidIssuePath(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true }
      | { success: false; error: { issues: Array<{ path?: Array<PropertyKey> }> } };
  },
  config: unknown,
  expectedPath: string,
) {
  const res = schema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues[0]?.path?.join(".")).toBe(expectedPath);
  }
}

function expectSchemaConfigValue(params: {
  schema: { safeParse: (value: unknown) => { success: true; data: unknown } | { success: false } };
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected schema config to be valid");
  }
  expect(params.readValue(res.data)).toBe(params.expectedValue);
}

describe("legacy config detection", () => {
  it.each([
    {
      name: "routing.allowFrom",
      input: { routing: { allowFrom: ["+15555550123"] } },
      expectedPath: "",
      expectedMessage: '"routing"',
    },
    {
      name: "routing.groupChat.requireMention",
      input: { routing: { groupChat: { requireMention: false } } },
      expectedPath: "",
      expectedMessage: '"routing"',
    },
  ] as const)(
    "rejects legacy routing key: $name",
    ({ input, expectedPath, expectedMessage, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, name).toBe(expectedPath);
        expect(res.issues[0]?.message, name).toContain(expectedMessage);
      }
    },
  );

  it("accepts per-agent tools.elevated overrides", async () => {
    const res = validateConfigObject({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: {
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config?.agents?.list?.[0]?.tools?.elevated).toEqual({
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      });
    }
  });
  it("rejects telegram.requireMention", async () => {
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("");
      expect(res.issues[0]?.message).toContain('"telegram"');
    }
  });
  it("rejects channels.telegram.groupMentionsOnly", async () => {
    const issues = findLegacyConfigIssues({
      channels: { telegram: { groupMentionsOnly: true } },
    });
    expect(issues.some((issue) => issue.path === "channels.telegram.groupMentionsOnly")).toBe(true);
  });
  it("rejects gateway.token", async () => {
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway");
    }
  });
  it.each(["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"] as const)(
    "flags gateway.bind host alias as legacy: %s",
    (bind) => {
      const validated = validateConfigObject({ gateway: { bind } });
      expect(validated.ok, bind).toBe(false);
      if (!validated.ok) {
        expect(
          validated.issues.some((issue) => issue.path === "gateway.bind"),
          bind,
        ).toBe(true);
      }
    },
  );
  it.each([
    {
      name: "telegram",
      schema: TelegramConfigSchema,
      allowFrom: ["123456789"],
      expectedIssuePath: "allowFrom",
    },
    {
      name: "whatsapp",
      schema: WhatsAppConfigSchema,
      allowFrom: ["+15555550123"],
      expectedIssuePath: "allowFrom",
    },
    {
      name: "signal",
      schema: SignalConfigSchema,
      allowFrom: ["+15555550123"],
      expectedIssuePath: "allowFrom",
    },
    {
      name: "imessage",
      schema: IMessageConfigSchema,
      allowFrom: ["+15555550123"],
      expectedIssuePath: "allowFrom",
    },
  ] as const)(
    'enforces dmPolicy="open" allowFrom wildcard for $name',
    ({ name, schema, allowFrom, expectedIssuePath }) => {
      if (schema) {
        expectSchemaInvalidIssuePath(schema, { dmPolicy: "open", allowFrom }, expectedIssuePath);
        return;
      }
      const res = validateConfigObject({
        channels: {
          [name]: { dmPolicy: "open", allowFrom },
        },
      });
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, name).toBe(expectedIssuePath);
      }
    },
    180_000,
  );

  it.each([
    ["telegram", TelegramConfigSchema],
    ["whatsapp", WhatsAppConfigSchema],
    ["signal", SignalConfigSchema],
  ] as const)('accepts dmPolicy="open" with wildcard for %s', (provider, schema) => {
    expectSchemaConfigValue({
      schema,
      config: { dmPolicy: "open", allowFrom: ["*"] },
      readValue: (config) => (config as { dmPolicy?: string }).dmPolicy,
      expectedValue: "open",
    });
  });

  it.each([
    ["telegram", TelegramConfigSchema],
    ["whatsapp", WhatsAppConfigSchema],
    ["signal", SignalConfigSchema],
  ] as const)("defaults dm/group policy for configured provider %s", (provider, schema) => {
    expectSchemaConfigValue({
      schema,
      config: {},
      readValue: (config) => (config as { dmPolicy?: string }).dmPolicy,
      expectedValue: "pairing",
    });
    expectSchemaConfigValue({
      schema,
      config: {},
      readValue: (config) => (config as { groupPolicy?: string }).groupPolicy,
      expectedValue: "allowlist",
    });
  });
  it("accepts historyLimit overrides per provider and account", async () => {
    expectSchemaConfigValue({
      schema: WhatsAppConfigSchema,
      config: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 9,
    });
    expectSchemaConfigValue({
      schema: WhatsAppConfigSchema,
      config: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
      readValue: (config) =>
        (config as { accounts?: { work?: { historyLimit?: number } } }).accounts?.work
          ?.historyLimit,
      expectedValue: 4,
    });
    expectSchemaConfigValue({
      schema: TelegramConfigSchema,
      config: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 8,
    });
    expectSchemaConfigValue({
      schema: TelegramConfigSchema,
      config: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
      readValue: (config) =>
        (config as { accounts?: { ops?: { historyLimit?: number } } }).accounts?.ops?.historyLimit,
      expectedValue: 3,
    });
    expectSchemaConfigValue({
      schema: SlackConfigSchema,
      config: { historyLimit: 7, accounts: { ops: { historyLimit: 2 } } },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 7,
    });
    expectSchemaConfigValue({
      schema: SlackConfigSchema,
      config: { historyLimit: 7, accounts: { ops: { historyLimit: 2 } } },
      readValue: (config) =>
        (config as { accounts?: { ops?: { historyLimit?: number } } }).accounts?.ops?.historyLimit,
      expectedValue: 2,
    });
    expectSchemaConfigValue({
      schema: SignalConfigSchema,
      config: { historyLimit: 6 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 6,
    });
    expectSchemaConfigValue({
      schema: IMessageConfigSchema,
      config: { historyLimit: 5 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 5,
    });
    expectSchemaConfigValue({
      schema: MSTeamsConfigSchema,
      config: { historyLimit: 4 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 4,
    });
    expectSchemaConfigValue({
      schema: DiscordConfigSchema,
      config: { historyLimit: 3 },
      readValue: (config) => (config as { historyLimit?: number }).historyLimit,
      expectedValue: 3,
    });
  });
});
