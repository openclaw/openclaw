import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ChannelSetupPlugin } from "./setup-wizard-types.js";
import {
  buildChannelSetupWizardAdapterFromSetupWizard,
  type ChannelSetupWizard,
} from "./setup-wizard.js";

const unexpectedSelect: WizardPrompter["select"] = async () => {
  throw new Error("unexpected select");
};

const unexpectedMultiselect: WizardPrompter["multiselect"] = async () => {
  throw new Error("unexpected multiselect");
};

function createTextPrompter(text: WizardPrompter["text"]): WizardPrompter {
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: unexpectedSelect,
    multiselect: unexpectedMultiselect,
    text,
    confirm: vi.fn(async () => true),
    progress: () => ({
      update: vi.fn(),
      stop: vi.fn(),
    }),
  };
}

function createPlugin(): ChannelSetupPlugin {
  return createChannelTestPluginBase({ id: "test-channel" });
}

function createWizard(params: {
  required?: boolean;
  applySet?: (value: string, cfg: OpenClawConfig) => OpenClawConfig;
}): ChannelSetupWizard {
  return {
    channel: "test-channel",
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      resolveConfigured: () => false,
    },
    credentials: [],
    textInputs: [
      {
        inputKey: "httpUrl",
        message: "Webhook URL",
        ...(params.required === undefined ? {} : { required: params.required }),
        applySet: ({ cfg, value }) => params.applySet?.(value, cfg) ?? cfg,
      },
    ],
  };
}

async function configureWithTextResult(params: {
  required?: boolean;
  rawValue: unknown;
  applySet?: (value: string, cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const text = vi.fn(async ({ validate }: Parameters<WizardPrompter["text"]>[0]) => {
    expect(validate?.(params.rawValue as string)).toBe(
      params.required === false ? undefined : "Required",
    );
    return params.rawValue as string;
  });
  const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
    plugin: createPlugin(),
    wizard: createWizard({ required: params.required, applySet: params.applySet }),
  });

  const result = await adapter.configure({
    cfg: {},
    runtime: {} as RuntimeEnv,
    prompter: createTextPrompter(text),
    accountOverrides: {},
    shouldPromptAccountIds: false,
    forceAllowFrom: false,
  });

  return { result, text };
}

describe("buildChannelSetupWizardAdapterFromSetupWizard", () => {
  it.each([undefined, { cancelled: true }])(
    "treats optional non-string text result %s as empty without trimming crash",
    async (rawValue) => {
      const applySet = vi.fn((value: string, cfg: OpenClawConfig) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          "test-channel": { value },
        },
      }));

      const { result, text } = await configureWithTextResult({
        required: false,
        rawValue,
        applySet,
      });

      expect(result.cfg).toEqual({});
      expect(text).toHaveBeenCalledOnce();
      expect(applySet).not.toHaveBeenCalled();
    },
  );

  it("does not accept an empty normalized result for required text input", async () => {
    await expect(
      configureWithTextResult({
        rawValue: undefined,
        applySet: vi.fn(),
      }),
    ).rejects.toThrow("Required");
  });
});
