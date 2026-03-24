import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { resolveChannelDefaultAccountId } from "./helpers.js";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ChannelOnboardingStatus,
  ChannelOnboardingStatusContext,
} from "./onboarding-types.js";
import {
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  runSingleChannelSecretStep,
  splitOnboardingEntries,
} from "./onboarding/helpers.js";
import type { ChannelSetupInput } from "./types.core.js";
import type { ChannelPlugin } from "./types.js";

/** Generic text input step in a channel setup wizard. */
export type ChannelSetupWizardTextInput = {
  /** The key in ChannelSetupInput to write the value to. */
  inputKey: keyof ChannelSetupInput;
  /** Prompt message shown to the user. */
  message: string;
  /** Placeholder text shown in the input field. */
  placeholder?: string;
  /** Whether the input is required. */
  required?: boolean;
  /** Whether to apply an empty value (clear the field). */
  applyEmptyValue?: boolean;
  /** Resolve current value from config (shown as default). */
  currentValue?: (params: { cfg: OpenClawConfig; accountId: string }) => string | undefined;
  /** Resolve initial value for the input field. */
  initialValue?: (params: { cfg: OpenClawConfig; accountId: string }) => string | undefined;
  /** Return true when this input should be shown. */
  shouldPrompt?: (params: { cfg: OpenClawConfig; accountId: string }) => boolean | Promise<boolean>;
  /** Whether to confirm the current value instead of prompting a new one. */
  confirmCurrentValue?: boolean;
  /** Whether to apply the current value without prompting if available. */
  applyCurrentValue?: boolean;
  helpTitle?: string;
  helpLines?: string[];
  /** Prompt shown when keeping the existing value. */
  keepPrompt?: string | ((value: string) => string);
  /** Validate the input value; return an error string or undefined. */
  validate?: (params: { cfg: OpenClawConfig; accountId: string; value: string }) => string | undefined;
  /** Apply the set value to config. */
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    value: string;
    credentialValues?: Record<string, string>;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardStatus = {
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint?: string;
  unconfiguredHint?: string;
  configuredScore?: number;
  unconfiguredScore?: number;
  resolveConfigured: (params: { cfg: OpenClawConfig }) => boolean | Promise<boolean>;
  resolveStatusLines?: (params: {
    cfg: OpenClawConfig;
    configured: boolean;
  }) => string[] | Promise<string[]>;
  resolveSelectionHint?: (params: { cfg: OpenClawConfig }) => string | undefined | Promise<string | undefined>;
  resolveQuickstartScore?: (params: { cfg: OpenClawConfig }) => number | undefined | Promise<number | undefined>;
};

export type ChannelSetupWizardCredentialState = {
  accountConfigured: boolean;
  hasConfiguredValue: boolean;
  resolvedValue?: string;
  envValue?: string;
};

export type ChannelSetupWizardCredential = {
  inputKey: keyof ChannelSetupInput;
  providerHint: string;
  credentialLabel: string;
  preferredEnvVar?: string;
  helpTitle?: string;
  helpLines?: string[];
  envPrompt?: string;
  keepPrompt?: string;
  inputPrompt?: string;
  allowEnv?: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  inspect?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => ChannelSetupWizardCredentialState;
  applyUseEnv?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolvedValue: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardAllowFromEntry = {
  input: string;
  resolved: boolean;
  id: string | null;
};

export type ChannelSetupWizardGroupAccessParams = {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues?: Record<string, string>;
  entries: string[];
  prompter: import("../../wizard/prompts.js").WizardPrompter;
};

export type ChannelSetupWizardGroupAccess = {
  label: string;
  placeholder?: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: (params: { cfg: OpenClawConfig; accountId: string }) => string;
  currentEntries: (params: { cfg: OpenClawConfig; accountId: string }) => string[];
  updatePrompt: string | ((params: { cfg: OpenClawConfig; accountId: string }) => string);
  setPolicy: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    policy: import("../../config/types.base.js").GroupPolicy;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
  resolveAllowlist?: (params: ChannelSetupWizardGroupAccessParams) => Promise<unknown>;
  applyAllowlist: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: unknown;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardAllowFrom = {
  helpTitle?: string;
  helpLines?: string[];
  message: string;
  placeholder?: string;
  invalidWithoutCredentialNote?: string;
  parseInputs?: (raw: string) => string[];
  parseId: (raw: string) => string | null;
  /** The credential inputKey whose resolved value to pass to resolveEntries. */
  credentialInputKey?: keyof ChannelSetupInput;
  resolveEntries: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValue?: string;
    credentialValues?: Record<string, string>;
    entries: string[];
  }) => Promise<ChannelSetupWizardAllowFromEntry[]>;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    allowFrom: string[];
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardIntroNote = {
  title: string;
  lines: string[];
};

export type ChannelSetupWizardEnvShortcut = {
  prompt: string;
  preferredEnvVar: string;
  isAvailable: (params: { cfg: OpenClawConfig; accountId: string }) => boolean | Promise<boolean>;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardRuntime = RuntimeEnv;

export type ChannelSetupWizardFinalizeResult = {
  cfg: OpenClawConfig;
};

export type ChannelSetupWizard = {
  channel: string;
  status: ChannelSetupWizardStatus;
  /** Primary credential for this wizard. */
  credential?: ChannelSetupWizardCredential;
  /** Multiple credentials supported by this wizard (may be empty). */
  credentials?: ChannelSetupWizardCredential[];
  dmPolicy?: ChannelOnboardingDmPolicy;
  allowFrom?: ChannelSetupWizardAllowFrom;
  introNote?: ChannelSetupWizardIntroNote;
  envShortcut?: ChannelSetupWizardEnvShortcut;
  textInputs?: ChannelSetupWizardTextInput[];
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  onAccountRecorded?: ChannelOnboardingAdapter["onAccountRecorded"];
  resolveAccountIdForConfigure?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => string | Promise<string>;
  resolveShouldPromptAccountIds?: (params: {
    options?: Record<string, unknown>;
    shouldPromptAccountIds?: boolean;
  }) => boolean;
  prepare?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    prompter: WizardPrompter;
  }) => Promise<{ cfg: OpenClawConfig } | undefined>;
  finalize?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    forceAllowFrom: boolean;
    prompter: WizardPrompter;
    runtime: ChannelSetupWizardRuntime;
    options?: Record<string, unknown>;
  }) => Promise<ChannelSetupWizardFinalizeResult | undefined>;
  completionNote?: string | ((params: { cfg: OpenClawConfig; accountId: string }) => string);
  groupAccess?: ChannelSetupWizardGroupAccess;
};

type ChannelSetupWizardPlugin = Pick<ChannelPlugin, "id" | "meta" | "config" | "setup"> &
  Partial<Pick<ChannelPlugin, "capabilities">>;

async function buildStatus(
  plugin: ChannelSetupWizardPlugin,
  wizard: ChannelSetupWizard,
  ctx: ChannelOnboardingStatusContext,
): Promise<ChannelOnboardingStatus> {
  const configured = await wizard.status.resolveConfigured({ cfg: ctx.cfg });
  return {
    channel: plugin.id,
    configured,
    statusLines: [
      `${plugin.meta.label}: ${configured ? wizard.status.configuredLabel : wizard.status.unconfiguredLabel}`,
    ],
    selectionHint: configured ? wizard.status.configuredHint : wizard.status.unconfiguredHint,
    quickstartScore: configured ? wizard.status.configuredScore : wizard.status.unconfiguredScore,
  };
}

function applySetupInput(params: {
  plugin: ChannelSetupWizardPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}) {
  const setup = params.plugin.setup;
  if (!setup?.applyAccountConfig) {
    throw new Error(`${params.plugin.id} does not support setup`);
  }
  const resolvedAccountId =
    setup.resolveAccountId?.({
      cfg: params.cfg,
      accountId: params.accountId,
      input: params.input,
    }) ?? params.accountId;
  const validationError = setup.validateInput?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    input: params.input,
  });
  if (validationError) {
    throw new Error(validationError);
  }
  let next = setup.applyAccountConfig({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    input: params.input,
  });
  if (params.input.name?.trim() && setup.applyAccountName) {
    next = setup.applyAccountName({
      cfg: next,
      accountId: resolvedAccountId,
      name: params.input.name,
    });
  }
  return {
    cfg: next,
    accountId: resolvedAccountId,
  };
}

export function buildChannelOnboardingAdapterFromSetupWizard(params: {
  plugin: ChannelSetupWizardPlugin;
  wizard: ChannelSetupWizard;
}): ChannelOnboardingAdapter {
  const { plugin, wizard } = params;
  return {
    channel: plugin.id,
    getStatus: async (ctx) => buildStatus(plugin, wizard, ctx),
    configure: async ({
      cfg,
      prompter,
      options,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom,
    }) => {
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin: plugin as ChannelPlugin,
        cfg,
      });
      const accountId = await resolveAccountIdForConfigure({
        cfg,
        prompter,
        label: plugin.meta.label,
        accountOverride: accountOverrides[plugin.id],
        shouldPromptAccountIds,
        listAccountIds: plugin.config.listAccountIds,
        defaultAccountId,
      });

      let next = cfg;
      let resolvedCredentialValue: string | undefined;
      if (wizard.credential) {
        const cred = wizard.credential;
        let credentialState = cred.inspect?.({ cfg: next, accountId }) ?? {
          accountConfigured: false,
          hasConfiguredValue: false,
        };
        resolvedCredentialValue = credentialState.resolvedValue?.trim() || undefined;
        const allowEnv = cred.allowEnv?.({ cfg: next, accountId }) ?? false;

        const credentialResult = await runSingleChannelSecretStep({
          cfg: next,
          prompter,
          providerHint: cred.providerHint,
          credentialLabel: cred.credentialLabel,
          secretInputMode: options?.secretInputMode,
          accountConfigured: credentialState.accountConfigured,
          hasConfigToken: credentialState.hasConfiguredValue,
          allowEnv,
          envValue: credentialState.envValue,
          envPrompt: cred.envPrompt ?? "",
          keepPrompt: cred.keepPrompt ?? "",
          inputPrompt: cred.inputPrompt ?? "",
          preferredEnvVar: cred.preferredEnvVar,
          onMissingConfigured:
            cred.helpLines && cred.helpLines.length > 0
              ? async () => {
                  await prompter.note(
                    cred.helpLines!.join("\n"),
                    cred.helpTitle ?? cred.credentialLabel,
                  );
                }
              : undefined,
          applyUseEnv: async (currentCfg) =>
            applySetupInput({
              plugin,
              cfg: currentCfg,
              accountId,
              input: {
                [cred.inputKey]: undefined,
                useEnv: true,
              },
            }).cfg,
          applySet: async (currentCfg, value, resolvedValue) => {
            resolvedCredentialValue = resolvedValue;
            return applySetupInput({
              plugin,
              cfg: currentCfg,
              accountId,
              input: {
                [cred.inputKey]: value,
                useEnv: false,
              },
            }).cfg;
          },
        });

        next = credentialResult.cfg;
        credentialState = cred.inspect?.({ cfg: next, accountId }) ?? credentialState;
        resolvedCredentialValue =
          credentialResult.resolvedValue?.trim() ||
          credentialState.resolvedValue?.trim() ||
          undefined;
      }

      if (forceAllowFrom && wizard.allowFrom) {
        if (wizard.allowFrom.helpLines && wizard.allowFrom.helpLines.length > 0) {
          await prompter.note(
            wizard.allowFrom.helpLines.join("\n"),
            wizard.allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          );
        }
        const existingAllowFrom =
          plugin.config.resolveAllowFrom?.({
            cfg: next,
            accountId,
          }) ?? [];
        const unique = await promptResolvedAllowFrom({
          prompter,
          existing: existingAllowFrom,
          token: resolvedCredentialValue,
          message: wizard.allowFrom.message,
          placeholder: wizard.allowFrom.placeholder ?? "",
          label: wizard.allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          parseInputs: wizard.allowFrom.parseInputs ?? splitOnboardingEntries,
          parseId: wizard.allowFrom.parseId,
          invalidWithoutTokenNote: wizard.allowFrom.invalidWithoutCredentialNote ?? "",
          resolveEntries: async ({ entries }) =>
            wizard.allowFrom!.resolveEntries({
              cfg: next,
              accountId,
              credentialValue: resolvedCredentialValue,
              entries,
            }),
        });
        next = await wizard.allowFrom.apply({
          cfg: next,
          accountId,
          allowFrom: unique,
        });
      }

      return { cfg: next, accountId };
    },
    dmPolicy: wizard.dmPolicy,
    disable: wizard.disable,
    onAccountRecorded: wizard.onAccountRecorded,
  };
}
