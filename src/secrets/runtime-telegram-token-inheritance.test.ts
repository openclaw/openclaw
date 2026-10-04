/** Tests Telegram token inheritance in secrets runtime collection. */
import { describe, expect, it } from "vitest";
import "./runtime-telegram.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

describe("secrets runtime snapshot telegram token inheritance", () => {
  it("fails when enabled channel surfaces contain unresolved refs", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            telegram: {
              botToken: envRef("MISSING_ENABLED_TELEGRAM_TOKEN"),
              accounts: {
                work: {
                  enabled: true,
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow('Environment variable "MISSING_ENABLED_TELEGRAM_TOKEN" is missing or empty.');
  });

  it("treats top-level Telegram token as inactive when all enabled accounts override it", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            botToken: envRef("UNUSED_TELEGRAM_BASE_TOKEN"),
            accounts: {
              work: {
                enabled: true,
                botToken: envRef("TELEGRAM_WORK_TOKEN"),
              },
              disabled: {
                enabled: false,
              },
            },
          },
        },
      }),
      env: {
        TELEGRAM_WORK_TOKEN: "telegram-work-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe(
      "telegram-work-token",
    );
    expect(snapshot.config.channels?.telegram?.botToken).toEqual(
      envRef("UNUSED_TELEGRAM_BASE_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram account overrides as enabled when account.enabled is omitted", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            telegram: {
              enabled: true,
              accounts: {
                inheritedEnabled: {
                  botToken: envRef("MISSING_INHERITED_TELEGRAM_ACCOUNT_TOKEN"),
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow(
      'Environment variable "MISSING_INHERITED_TELEGRAM_ACCOUNT_TOKEN" is missing or empty.',
    );
  });

  it("treats top-level Telegram botToken refs as active when account botToken is blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            botToken: envRef("TELEGRAM_BASE_TOKEN"),
            accounts: {
              work: {
                enabled: true,
                botToken: "",
              },
            },
          },
        },
      }),
      env: {
        TELEGRAM_BASE_TOKEN: "telegram-base-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toBe("telegram-base-token");
    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toBe("");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram webhookSecret refs as inactive when webhook mode is not configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            webhookSecret: envRef("MISSING_TELEGRAM_WEBHOOK_SECRET"),
            accounts: {
              work: {
                enabled: true,
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.webhookSecret).toEqual(
      envRef("MISSING_TELEGRAM_WEBHOOK_SECRET"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.webhookSecret",
    );
  });

  it("treats Telegram top-level botToken refs as inactive when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            tokenFile: "/tmp/telegram-bot-token",
            botToken: envRef("MISSING_TELEGRAM_BOT_TOKEN"),
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toEqual(
      envRef("MISSING_TELEGRAM_BOT_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.botToken",
    );
  });

  it("treats Telegram account botToken refs as inactive when account tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            accounts: {
              work: {
                enabled: true,
                tokenFile: "/tmp/telegram-work-bot-token",
                botToken: envRef("MISSING_TELEGRAM_WORK_BOT_TOKEN"),
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.telegram?.accounts?.work?.botToken).toEqual(
      envRef("MISSING_TELEGRAM_WORK_BOT_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.telegram.accounts.work.botToken",
    );
  });
});
