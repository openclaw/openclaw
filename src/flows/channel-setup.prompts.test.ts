// Channel setup prompt tests cover prompt choices and validation.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { ChannelSetupDmPolicy } from "../channels/plugins/setup-wizard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { maybeConfigureCommandOwner, maybeConfigureDmPolicies } from "./channel-setup.prompts.js";

describe("maybeConfigureDmPolicies", () => {
  it("localizes DM policy guidance and options", async () => {
    const note = vi.fn<WizardPrompter["note"]>(async () => {});
    const select = vi.fn(async () => "pairing") as unknown as WizardPrompter["select"];
    const prompter = {
      confirm: vi.fn(async () => true),
      note,
      select,
    } as unknown as WizardPrompter;
    const policy: ChannelSetupDmPolicy = {
      label: "Telegram",
      channel: "telegram" as ChannelSetupDmPolicy["channel"],
      policyKey: "channels.telegram.dmPolicy",
      allowFromKey: "channels.telegram.allowFrom",
      getCurrent: () => "pairing",
      setPolicy: (cfg: OpenClawConfig) => cfg,
    };

    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, async () => {
      await maybeConfigureDmPolicies({
        cfg: {},
        selection: ["telegram" as never],
        prompter,
        resolveAdapter: () => ({ dmPolicy: policy }) as never,
      });
    });

    expect(note.mock.calls[0]?.[0]).toContain("默认：配对");
    expect(note.mock.calls[0]?.[1]).toBe("Telegram DM 访问");
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Telegram DM 策略",
        options: expect.arrayContaining([
          expect.objectContaining({ label: "配对（推荐）", value: "pairing" }),
        ]),
      }),
    );
  });
});

const linkMessage =
  "Also link discord:123456789012345678 to your profile (Ada) so OpenClaw knows this chat account is you?";

it.each([
  ["accepted", true],
  ["declined", false],
] as const)(
  "offers a signed-in administrator an explicit operator-account link (%s)",
  async (_name, acceptLink) => {
    const prompter = createWizardPrompter({
      select: vi.fn(async () => "setup") as WizardPrompter["select"],
      text: vi.fn(async () => "discord:123456789012345678"),
      confirm: vi.fn(async ({ message }: { message: string }) =>
        message === linkMessage ? acceptLink : true,
      ),
    });
    const onLink = vi.fn();
    const next = await maybeConfigureCommandOwner({
      cfg: {},
      channels: [{ id: "discord", label: "Discord", accountId: "team-bot" }],
      prompter,
      operatorProfile: { label: "Ada", onLink },
    });

    expect(next.commands?.ownerAllowFrom).toEqual(["discord:123456789012345678"]);
    expect(prompter.confirm).toHaveBeenCalledWith({ message: linkMessage, initialValue: true });
    expect(onLink.mock.calls).toEqual(
      acceptLink
        ? [[{ channelId: "discord", accountId: "team-bot", senderId: "123456789012345678" }]]
        : [],
    );
  },
);

it("does not offer a link without a signed-in person profile", async () => {
  const prompter = createWizardPrompter({
    select: vi.fn(async () => "setup") as WizardPrompter["select"],
    text: vi.fn(async () => "123456789012345678"),
    confirm: vi.fn(async () => true),
  });
  await maybeConfigureCommandOwner({
    cfg: {},
    channels: [{ id: "discord", label: "Discord", accountId: "default" }],
    prompter,
  });
  expect(prompter.confirm).toHaveBeenCalledOnce();
});
