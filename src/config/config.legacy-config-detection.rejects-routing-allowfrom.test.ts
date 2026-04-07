import { describe, expect, it } from "vitest";
import {
  IMessageConfigSchema,
  SignalConfigSchema,
  TelegramConfigSchema,
  WhatsAppConfigSchema,
} from "../plugin-sdk/channel-config-schema.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { validateConfigObject } from "./validation.js";
import {
  DiscordConfigSchema,
  MSTeamsConfigSchema,
  SlackConfigSchema,
} from "./zod-schema.providers-core.js";

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

function expectProviderValidationIssuePath(params: {
  provider: string;
  config: unknown;
  expectedPath: string;
}) {
  const res = validateConfigObject({
    channels: {
      [params.provider]: params.config,
    },
  });
  expect(res.ok, params.provider).toBe(false);
  if (!res.ok) {
    expect(res.issues[0]?.path, params.provider).toBe(params.expectedPath);
  }
}

function expectProviderConfigValue(params: {
  provider: string;
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = validateConfigObject({
    channels: {
      [params.provider]: params.config,
    },
  });
  expect(res.ok, params.provider).toBe(true);
  if (!res.ok) {
    throw new Error(`expected ${params.provider} config to be valid`);
  }
  expect(params.readValue(res.config)).toBe(params.expectedValue);
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
      allowFrom: ["123456789"],
      expectedIssuePath: "channels.telegram.allowFrom",
    },
    {
      name: "whatsapp",
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.whatsapp.allowFrom",
    },
    {
      name: "signal",
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.signal.allowFrom",
    },
    {
      name: "imessage",
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.imessage.allowFrom",
    },
  ] as const)(
    'enforces dmPolicy="open" allowFrom wildcard for $name',
    ({ name, allowFrom, expectedIssuePath }) => {
      expectProviderValidationIssuePath({
        provider: name,
        config: { dmPolicy: "open", allowFrom },
        expectedPath: expectedIssuePath,
      });
    },
    180_000,
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    'accepts dmPolicy="open" with wildcard for %s',
    (provider) => {
      expectProviderConfigValue({
        provider,
        config: { dmPolicy: "open", allowFrom: ["*"] },
        readValue: (config) =>
          (
            config as {
              channels?: Record<string, { dmPolicy?: string } | undefined>;
            }
          ).channels?.[provider]?.dmPolicy,
        expectedValue: "open",
      });
    },
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    "defaults dm/group policy for configured provider %s",
    (provider) => {
      expectProviderConfigValue({
        provider,
        config: {},
        readValue: (config) =>
          (
            config as {
              channels?: Record<string, { dmPolicy?: string } | undefined>;
            }
          ).channels?.[provider]?.dmPolicy,
        expectedValue: "pairing",
      });
      expectProviderConfigValue({
        provider,
        config: {},
        readValue: (config) =>
          (
            config as {
              channels?: Record<string, { groupPolicy?: string } | undefined>;
            }
          ).channels?.[provider]?.groupPolicy,
        expectedValue: "allowlist",
      });
    },
  );

  it("accepts historyLimit overrides per provider and account", async () => {
    expectProviderConfigValue({
      provider: "whatsapp",
      config: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
      readValue: (config) =>
        (
          config as { channels?: { whatsapp?: { historyLimit?: number } } }
        ).channels?.whatsapp?.historyLimit,
      expectedValue: 9,
    });
    expectProviderConfigValue({
      provider: "whatsapp",
      config: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
      readValue: (config) =>
        (
          config as {
            channels?: { whatsapp?: { accounts?: { work?: { historyLimit?: number } } } };
          }
        ).channels?.whatsapp?.accounts?.work?.historyLimit,
      expectedValue: 4,
    });
    expectProviderConfigValue({
      provider: "telegram",
      config: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
      readValue: (config) =>
        (
          config as { channels?: { telegram?: { historyLimit?: number } } }
        ).channels?.telegram?.historyLimit,
      expectedValue: 8,
    });
    expectProviderConfigValue({
      provider: "telegram",
      config: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
      readValue: (config) =>
        (
          config as {
            channels?: { telegram?: { accounts?: { ops?: { historyLimit?: number } } } };
          }
        ).channels?.telegram?.accounts?.ops?.historyLimit,
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
    expectProviderConfigValue({
      provider: "signal",
      config: { historyLimit: 6 },
      readValue: (config) =>
        (
          config as { channels?: { signal?: { historyLimit?: number } } }
        ).channels?.signal?.historyLimit,
      expectedValue: 6,
    });
    expectProviderConfigValue({
      provider: "imessage",
      config: { historyLimit: 5 },
      readValue: (config) =>
        (
          config as { channels?: { imessage?: { historyLimit?: number } } }
        ).channels?.imessage?.historyLimit,
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
