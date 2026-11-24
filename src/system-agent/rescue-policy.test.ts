import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSystemAgentRescueMessage } from "./rescue-message.js";

describe("OpenClaw rescue eligibility", () => {
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    senderIsOwner: boolean;
    isGroup: boolean;
    reply: string;
  }>([
    {
      name: "active sandbox",
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } },
      senderIsOwner: true,
      isGroup: false,
      reply:
        "OpenClaw rescue is blocked because OpenClaw sandboxing is active. Fix the install locally or disable sandboxing before using remote rescue.",
    },
    {
      name: "restricted host posture",
      cfg: { tools: { exec: { security: "allowlist", ask: "always" } } },
      senderIsOwner: true,
      isGroup: false,
      reply: "OpenClaw rescue requires YOLO host posture with sandboxing off.",
    },
    {
      name: "non-owner sender",
      cfg: {},
      senderIsOwner: false,
      isGroup: false,
      reply: "OpenClaw rescue only accepts commands from an OpenClaw owner.",
    },
    {
      name: "group conversation",
      cfg: {},
      senderIsOwner: true,
      isGroup: true,
      reply: "OpenClaw rescue is restricted to owner DMs by default.",
    },
  ])(
    "denies $name through the rescue entry point",
    async ({ cfg, senderIsOwner, isGroup, reply }) => {
      await withTestDir({ prefix: "openclaw-rescue-policy-" }, async (root) => {
        await withEnvAsync(
          {
            HOME: root,
            OPENCLAW_HOME: path.join(root, ".openclaw"),
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "xdg-state"),
          },
          async () => {
            const commandBody = "/openclaw restart gateway";
            const command: CommandContext = {
              surface: "whatsapp",
              channel: "whatsapp",
              channelId: "whatsapp",
              accountId: "default",
              ownerList: ["user:owner"],
              senderIsOwner,
              isAuthorizedSender: true,
              senderId: senderIsOwner ? "user:owner" : "user:other",
              rawBodyNormalized: commandBody,
              commandBodyNormalized: commandBody,
              from: senderIsOwner ? "user:owner" : "user:other",
              to: "account:default",
            };
            resetPluginStateStoreForTests();
            try {
              await expect(
                runSystemAgentRescueMessage({ cfg, command, commandBody, isGroup }),
              ).resolves.toBe(reply);
            } finally {
              try {
                await closeOpenClawStateDatabaseAsync();
              } finally {
                resetPluginStateStoreForTests();
              }
            }
          },
        );
      });
    },
  );
});
