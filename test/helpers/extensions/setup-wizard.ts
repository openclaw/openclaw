import { vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { createRuntimeEnv } from "./runtime-env.js";

export type { WizardPrompter } from "../../../src/wizard/prompts.js";

export async function selectFirstWizardOption<T>(params: {
  options: Array<{ value: T }>;
}): Promise<T> {
  const first = params.options[0];
  if (!first) {
    throw new Error("no options");
  }
  return first.value;
}

export function createTestWizardPrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: selectFirstWizardOption as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

export function createQueuedWizardPrompter(params?: {
  selectValues?: string[];
  textValues?: string[];
  confirmValues?: boolean[];
}) {
  const selectValues = [...(params?.selectValues ?? [])];
  const textValues = [...(params?.textValues ?? [])];
  const confirmValues = [...(params?.confirmValues ?? [])];

  const intro = vi.fn(async () => undefined);
  const outro = vi.fn(async () => undefined);
  const note = vi.fn(async () => undefined);
  const select = vi.fn(async () => selectValues.shift() ?? "");
  const multiselect = vi.fn(async () => [] as string[]);
  const text = vi.fn(async () => textValues.shift() ?? "");
  const confirm = vi.fn(async () => confirmValues.shift() ?? false);
  const progress = vi.fn(() => ({
    update: vi.fn(),
    stop: vi.fn(),
  }));

  return {
    intro,
    outro,
    note,
    select,
    multiselect,
    text,
    confirm,
    progress,
    prompter: createTestWizardPrompter({
      intro,
      outro,
      note,
      select: select as WizardPrompter["select"],
      multiselect: multiselect as WizardPrompter["multiselect"],
      text: text as WizardPrompter["text"],
      confirm,
      progress,
    }),
  };
}

type SetupWizardAdapterParams = Parameters<typeof buildChannelSetupWizardAdapterFromSetupWizard>[0];
type SetupWizardPlugin = SetupWizardAdapterParams["plugin"];
type SetupWizard = NonNullable<SetupWizardAdapterParams["wizard"]>;

export function createPluginSetupWizardAdapter<
  TPlugin extends SetupWizardPlugin & { setupWizard?: SetupWizard },
>(plugin: TPlugin) {
  const wizard = plugin.setupWizard;
  if (!wizard) {
    throw new Error(`${plugin.id} is missing setupWizard`);
  }
  return buildChannelSetupWizardAdapterFromSetupWizard({
    plugin,
    wizard,
  });
}

export async function runSetupWizardConfigure<
  TCfg,
  TOptions extends Record<string, unknown>,
  TAccountOverrides extends Record<string, string | undefined>,
  TRuntime,
  TResult,
>(params: {
  configure: (args: {
    cfg: TCfg;
    runtime: TRuntime;
    prompter: WizardPrompter;
    options: TOptions;
    accountOverrides: TAccountOverrides;
    shouldPromptAccountIds: boolean;
    forceAllowFrom: boolean;
  }) => Promise<TResult>;
  cfg?: TCfg;
  runtime?: TRuntime;
  prompter: WizardPrompter;
  options?: TOptions;
  accountOverrides?: TAccountOverrides;
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
}): Promise<TResult> {
  return await params.configure({
    cfg: (params.cfg ?? {}) as TCfg,
    runtime: (params.runtime ?? createRuntimeEnv()) as TRuntime,
    prompter: params.prompter,
    options: (params.options ?? {}) as TOptions,
    accountOverrides: (params.accountOverrides ?? {}) as TAccountOverrides,
    shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
    forceAllowFrom: params.forceAllowFrom ?? false,
  });
}
