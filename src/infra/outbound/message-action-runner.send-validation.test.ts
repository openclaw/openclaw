import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  runDrySend,
  slackConfig,
  slackTestPlugin,
  telegramTestPlugin,
  whatsappTestPlugin,
} from "./message-action-runner.test-helpers.js";

describe("runMessageAction send validation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackTestPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramTestPlugin,
        },
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            ...whatsappTestPlugin,
            config: {
              ...whatsappTestPlugin.config,
              resolveDefaultTo: ({ cfg }) =>
                typeof cfg.channels?.whatsapp?.defaultTo === "string"
                  ? cfg.channels.whatsapp.defaultTo
                  : undefined,
            },
          },
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("allows send when only shared interactive payloads are provided", async () => {
    const result = await runDrySend({
      cfg: {
        channels: {
          telegram: {
            botToken: "telegram-test",
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "telegram",
        target: "123456",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only Slack blocks are provided", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        blocks: [{ type: "divider" }],
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("allows target-less WhatsApp sends when defaultTo is configured", async () => {
    const result = await runDrySend({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551234567"],
            defaultTo: "+15551234567",
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "whatsapp",
        message: "hello",
      },
    });

    expect(result.kind).toBe("send");
    if (result.kind !== "send") {
      throw new Error("expected send result");
    }
    expect(result.to).toBe("+15551234567");
  });

  it.each([
    {
      name: "structured poll params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
      },
    },
    {
      name: "string-encoded poll params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: "60",
        pollPublic: "true",
      },
    },
    {
      name: "snake_case poll params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
    {
      name: "negative poll duration params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: -5,
      },
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });
});
