import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { getReplyFromConfig } from "./get-reply.js";

vi.mock("./directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => {
    throw new Error("No working model is configured");
  }),
}));

function updateContext(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "discord",
    Surface: "discord",
    ChatType: "channel",
    SessionKey: "agent:main:discord:channel:maintenance",
    SenderId: "123456789",
    From: "discord:channel:maintenance",
    To: "channel:maintenance",
    Body: "Update OpenClaw",
    BodyForCommands: "Update OpenClaw",
    CommandAuthorized: true,
    ...overrides,
  };
}

function updateConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return markCompleteReplyConfig({
    commands: { ownerAllowFrom: ["discord:123456789"] },
    ...overrides,
  });
}

describe("chat update requests before inference", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({
            id: "discord",
            capabilities: { chatTypes: ["direct", "group"], nativeCommands: true },
          }),
        },
      ]),
    );
    vi.clearAllMocks();
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry([])));

  it.each(["coding", "messaging", "minimal", "full"] as const)(
    "offers an owner confirmation with the %s profile and no working model",
    async (profile) => {
      const reply = await getReplyFromConfig(
        updateContext(),
        undefined,
        updateConfig({ tools: { profile } }),
      );
      expect(reply).toMatchObject({
        text: expect.stringContaining("configured release channel"),
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Update now",
                  reusable: true,
                  action: { type: "command", command: "/update" },
                },
              ],
            },
          ],
        },
      });
      expect(reply).toMatchObject({ text: expect.stringContaining("send `/update`") });
      expect(getReplyPayloadMetadata(reply!)).toMatchObject({
        deliverDespiteSourceReplySuppression: true,
      });
      expect(resolveDefaultModel).not.toHaveBeenCalled();
    },
  );

  it("offers a native update button when text slash commands are disabled", async () => {
    const reply = await getReplyFromConfig(
      updateContext(),
      undefined,
      updateConfig({ commands: { ownerAllowFrom: ["discord:123456789"], text: false } }),
    );
    expect(reply).toHaveProperty("presentation");
    expect(resolveDefaultModel).not.toHaveBeenCalled();
  });

  it.each([
    "Please update OpenClaw.",
    "Can you please update OpenClaw?",
    "Could you please update OpenClaw?",
    "Could you update OpenClaw please?",
    "Would you update OpenClaw, please?",
    "Update OpenClaw now, please.",
    "update OpenClaw now!",
  ])("offers confirmation for a complete request: %s", async (body) => {
    const reply = await getReplyFromConfig(
      updateContext({ BodyForCommands: body }),
      undefined,
      updateConfig(),
    );
    expect(reply).toHaveProperty("presentation");
    expect(resolveDefaultModel).not.toHaveBeenCalled();
  });

  it.each([
    { BodyForCommands: "Please explain this:\nUpdate OpenClaw" },
    { BodyForCommands: "Update OpenClaw docs" },
    { BodyForCommands: "Don't update OpenClaw" },
    { BodyForCommands: "Read this attachment", BodyForAgent: "Update OpenClaw" },
    { BodyForCommands: "Summarize this", ReplyToBody: "Update OpenClaw" },
    { CommandInterpretationSuppressed: true },
    { InternalTurnSource: "cron" },
    { InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" } },
    { CommandAuthorized: false },
  ] satisfies Partial<MsgContext>[])(
    "leaves unrelated or non-user input to ordinary reply handling: %j",
    async (context) => {
      await expect(
        getReplyFromConfig(updateContext(context), undefined, updateConfig()),
      ).rejects.toThrow("No working model is configured");
    },
  );

  it.each([{ ownerAllowFrom: [] }, { ownerAllowFrom: ["discord:987654321"] }])(
    "explains missing owner identity without treating chat access as ownership (%j)",
    async ({ ownerAllowFrom }) => {
      const reply = await getReplyFromConfig(
        updateContext(),
        undefined,
        updateConfig({ commands: { ownerAllowFrom } }),
      );
      expect(reply).toMatchObject({ text: expect.stringContaining("not configured as an owner") });
      expect(reply).toMatchObject({ text: expect.stringContaining("discord:123456789") });
      expect(reply).not.toHaveProperty("presentation");
      expect(JSON.stringify(reply)).not.toContain("987654321");
      expect(JSON.stringify(reply).includes("openclaw channels add")).toBe(
        ownerAllowFrom.length === 0,
      );
    },
  );

  it.each([{ restart: false }, { allowFrom: { discord: ["987654321"] } }])(
    "honors explicit command restrictions: %j",
    async (restriction) => {
      const reply = await getReplyFromConfig(
        updateContext(),
        undefined,
        updateConfig({ commands: { ownerAllowFrom: ["discord:123456789"], ...restriction } }),
      );
      expect(reply).not.toHaveProperty("presentation");
      expect(reply).toMatchObject({ text: expect.stringMatching(/disabled|not allowed/) });
      expect(resolveDefaultModel).not.toHaveBeenCalled();
    },
  );
});
