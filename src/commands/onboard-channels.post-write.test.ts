import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelSetupWizardAdapter } from "./channel-setup/registry.js";
import type { ChannelSetupWizardAdapter } from "./channel-setup/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  createChannelOnboardingPostWriteHookCollector,
  runCollectedChannelOnboardingPostWriteHooks,
  setupChannels,
} from "./onboard-channels.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

function setMinimalTelegramOnboardingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          setup: {
            applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
          },
          setupWizard: {
            channel: "telegram",
            status: {
              configuredLabel: "Configured",
              unconfiguredLabel: "Not configured",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean(cfg.channels?.telegram?.botToken),
            },
            credentials: [],
          },
        },
      },
    ]),
  );
}

type ChannelSetupWizardAdapterPatch = Partial<
  Pick<
    ChannelSetupWizardAdapter,
    | "afterConfigWritten"
    | "configure"
    | "configureInteractive"
    | "configureWhenConfigured"
    | "getStatus"
  >
>;

type PatchedSetupAdapterFields = {
  afterConfigWritten?: ChannelSetupWizardAdapter["afterConfigWritten"];
  configure?: ChannelSetupWizardAdapter["configure"];
  configureInteractive?: ChannelSetupWizardAdapter["configureInteractive"];
  configureWhenConfigured?: ChannelSetupWizardAdapter["configureWhenConfigured"];
  getStatus?: ChannelSetupWizardAdapter["getStatus"];
};

function patchChannelOnboardingAdapterForTest(
  patch: ChannelSetupWizardAdapterPatch,
): () => void {
  const adapter = getChannelSetupWizardAdapter("telegram");
  if (!adapter) {
    throw new Error("missing setup adapter for telegram");
  }

  const previous: PatchedSetupAdapterFields = {};

  if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
    previous.getStatus = adapter.getStatus;
    adapter.getStatus = patch.getStatus ?? adapter.getStatus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "afterConfigWritten")) {
    previous.afterConfigWritten = adapter.afterConfigWritten;
    adapter.afterConfigWritten = patch.afterConfigWritten;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
    previous.configure = adapter.configure;
    adapter.configure = patch.configure ?? adapter.configure;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
    previous.configureInteractive = adapter.configureInteractive;
    adapter.configureInteractive = patch.configureInteractive;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
    previous.configureWhenConfigured = adapter.configureWhenConfigured;
    adapter.configureWhenConfigured = patch.configureWhenConfigured;
  }

  return () => {
    if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
      adapter.getStatus = previous.getStatus!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "afterConfigWritten")) {
      adapter.afterConfigWritten = previous.afterConfigWritten;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
      adapter.configure = previous.configure!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
      adapter.configureInteractive = previous.configureInteractive;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
      adapter.configureWhenConfigured = previous.configureWhenConfigured;
    }
  };
}

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
    setMinimalTelegramOnboardingRegistryForTests();
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
    const restore = patchChannelOnboardingAdapterForTest({
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
