import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  patchChannelOnboardingAdapter,
  setDefaultChannelPluginRegistryForTests,
} from "./channel-test-helpers.js";
import {
  createChannelOnboardingPostWriteHookCollector,
  runCollectedChannelOnboardingPostWriteHooks,
  setupChannels,
} from "./onboard-channels.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(
    {
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      ...overrides,
    },
    { defaultSelect: "__done__" },
  );
}

function createQuickstartTelegramSelect() {
  return vi.fn(async ({ message }: { message: string }) => {
    if (message === "Select channel (QuickStart)") {
      return "telegram";
    }
    return "__done__";
  });
}

function createUnexpectedQuickstartPrompter(select: WizardPrompter["select"]) {
  return createPrompter({
    select,
    multiselect: vi.fn(async () => {
      throw new Error("unexpected multiselect");
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    }) as unknown as WizardPrompter["text"],
  });
}

describe("setupChannels post-write hooks", () => {
  beforeEach(() => {
    setDefaultChannelPluginRegistryForTests();
  });

  it("collects onboarding post-write hooks and runs them against the final config", async () => {
    const select = createQuickstartTelegramSelect();
    const afterConfigWritten = vi.fn(async () => {});
    const configureInteractive = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: { ...cfg.channels?.telegram, botToken: "new-token" },
        },
      } as OpenClawConfig,
      accountId: "acct-1",
    }));
    const restore = patchChannelOnboardingAdapter("telegram", {
      configureInteractive,
      afterConfigWritten,
      getStatus: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
    });
    const prompter = createUnexpectedQuickstartPrompter(
      select as unknown as WizardPrompter["select"],
    );
    const collector = createChannelOnboardingPostWriteHookCollector();
    const runtime = createExitThrowingRuntime();

    try {
      const cfg = await setupChannels({} as OpenClawConfig, runtime, prompter, {
        quickstartDefaults: true,
        skipConfirm: true,
        onPostWriteHook: (hook) => {
          collector.collect(hook);
        },
      });

      expect(afterConfigWritten).not.toHaveBeenCalled();

      await runCollectedChannelOnboardingPostWriteHooks({
        hooks: collector.drain(),
        cfg,
        runtime,
      });

      expect(afterConfigWritten).toHaveBeenCalledWith({
        previousCfg: {} as OpenClawConfig,
        cfg,
        accountId: "acct-1",
        runtime,
      });
    } finally {
      restore();
    }
  });

  it("logs onboarding post-write hook failures without aborting", async () => {
    const runtime = createExitThrowingRuntime();

    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel: "telegram",
          accountId: "acct-1",
          run: async () => {
            throw new Error("hook failed");
          },
        },
      ],
      cfg: {} as OpenClawConfig,
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      'Channel telegram post-setup warning for "acct-1": hook failed',
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
