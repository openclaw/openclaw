import { describe, expect, it } from "vitest";
import "./runtime-telegram.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
function prepare(telegram: unknown, env: NodeJS.ProcessEnv = {}) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels: { telegram } }),
    env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
  });
}

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

describe("secrets runtime snapshot telegram token inheritance", () => {
  it("fails when enabled channel surfaces contain unresolved refs", async () => {
    await expect(
      prepare({
        botToken: envRef("MISSING_ENABLED_TELEGRAM_TOKEN"),
        accounts: { work: { enabled: true } },
      }),
    ).rejects.toThrow('Environment variable "MISSING_ENABLED_TELEGRAM_TOKEN" is missing or empty.');
  });

  it("resolves the implicit default's top-level token and webhookSecret when named accounts override them", async () => {
    const snapshot = await prepare(
      {
        botToken: envRef("TELEGRAM_BASE_TOKEN"),
        webhookUrl: "https://example.invalid/telegram",
        webhookSecret: envRef("TELEGRAM_BASE_WEBHOOK_SECRET"),
        accounts: {
          work: {
            enabled: true,
            botToken: envRef("TELEGRAM_WORK_TOKEN"),
            webhookSecret: envRef("TELEGRAM_WORK_WEBHOOK_SECRET"),
          },
        },
      },
      {
        TELEGRAM_BASE_TOKEN: "telegram-base-token",
        TELEGRAM_BASE_WEBHOOK_SECRET: "telegram-base-webhook-secret",
        TELEGRAM_WORK_TOKEN: "telegram-work-token",
        TELEGRAM_WORK_WEBHOOK_SECRET: "telegram-work-webhook-secret",
      },
    );

    expect(snapshot.config.channels?.telegram).toMatchObject({
      botToken: "telegram-base-token",
      webhookSecret: "telegram-base-webhook-secret",
      accounts: {
        work: { botToken: "telegram-work-token", webhookSecret: "telegram-work-webhook-secret" },
      },
    });
    expect(snapshot.warnings).toEqual([]);
  });

  it("treats top-level Telegram token as inactive when accounts.default overrides it", async () => {
    const snapshot = await prepare(
      {
        botToken: envRef("UNUSED_TELEGRAM_BASE_TOKEN"),
        accounts: {
          default: { enabled: true, botToken: "telegram-default-token" },
          work: {
            enabled: true,
            botToken: envRef("TELEGRAM_WORK_TOKEN"),
          },
          disabled: { enabled: false },
        },
      },
      { TELEGRAM_WORK_TOKEN: "telegram-work-token" },
    );

    expect(snapshot.config.channels?.telegram).toMatchObject({
      accounts: { work: { botToken: "telegram-work-token" } },
    });
    expect(snapshot.config.channels?.telegram?.botToken).toEqual(
      envRef("UNUSED_TELEGRAM_BASE_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats top-level Telegram botToken refs as active when account botToken is blank", async () => {
    const snapshot = await prepare(
      {
        botToken: envRef("TELEGRAM_BASE_TOKEN"),
        accounts: { work: { enabled: true, botToken: "" } },
      },
      { TELEGRAM_BASE_TOKEN: "telegram-base-token" },
    );

    expect(snapshot.config.channels?.telegram).toMatchObject({
      botToken: "telegram-base-token",
      accounts: { work: { botToken: "" } },
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.telegram.botToken",
    );
  });

  it.each(["channel", "account"])(
    "ignores %s botToken refs when tokenFile is configured",
    async (scope) => {
      const token = { tokenFile: "/tmp/telegram-bot-token", botToken: envRef("MISSING_TOKEN") };
      const snapshot = await prepare(
        scope === "channel" ? token : { accounts: { work: { enabled: true, ...token } } },
      );
      const telegram = snapshot.config.channels?.telegram;
      const configured = scope === "channel" ? telegram : telegram?.accounts?.work;
      expect(configured?.botToken).toEqual(token.botToken);
      expect(snapshot.warnings.map(({ path }) => path)).toContain(
        `channels.telegram.${scope === "account" ? "accounts.work." : ""}botToken`,
      );
    },
  );
});
