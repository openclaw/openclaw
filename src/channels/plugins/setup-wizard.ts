import type { OpenClawConfig } from "../../config/config.js";
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
import type { RuntimeEnv } from "../../runtime.js";
import type {
  ChannelSetupConfigureContext,
  ChannelSetupDmPolicy,
  ChannelSetupWizardAdapter,
  SetupChannelsOptions,
} from "./setup-wizard-types.js";
import type { ChannelSetupInput } from "./types.core.js";
import type { ChannelPlugin } from "./types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

// Inline alias for group access policy — keeps this file self-contained
// when setup-group-access.ts is not yet present.
// Matches GroupPolicy from config/types.base.ts.
type ChannelAccessPolicy = "open" | "allowlist" | "disabled";

// Credential values map (inputKey → resolved value) used across wizard steps.
type ChannelSetupWizardCredentialValues = Partial<Record<string, string>>;

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
  resolveSelectionHint?: (params: {
    cfg: OpenClawConfig;
    configured: boolean;
  }) => string | undefined | Promise<string | undefined>;
  resolveQuickstartScore?: (params: {
    cfg: OpenClawConfig;
    configured: boolean;
  }) => number | undefined | Promise<number | undefined>;
};

export type ChannelSetupWizardNote = {
  title: string;
  lines: string[];
  shouldShow?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => boolean | Promise<boolean>;
};

export type ChannelSetupWizardEnvShortcut = {
  prompt: string;
  preferredEnvVar?: string;
  isAvailable: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardTextInput = {
  inputKey: keyof ChannelSetupInput;
  message: string;
  placeholder?: string;
  required?: boolean;
  applyEmptyValue?: boolean;
  helpTitle?: string;
  helpLines?: string[];
  confirmCurrentValue?: boolean;
  keepPrompt?: string | ((value: string) => string);
  currentValue?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined | Promise<string | undefined>;
  initialValue?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined | Promise<string | undefined>;
  shouldPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    currentValue?: string;
  }) => boolean | Promise<boolean>;
  applyCurrentValue?: boolean;
  validate?: (params: {
    value: string;
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined;
  normalizeValue?: (params: {
    value: string;
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    value: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardGroupAccess = {
  label: string;
  placeholder: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: (params: { cfg: OpenClawConfig; accountId: string }) => ChannelAccessPolicy;
  currentEntries: (params: { cfg: OpenClawConfig; accountId: string }) => string[];
  updatePrompt: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  setPolicy: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    policy: ChannelAccessPolicy;
  }) => OpenClawConfig;
  resolveAllowlist?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    entries: string[];
    prompter: Pick<WizardPrompter, "note">;
  }) => Promise<unknown>;
  applyAllowlist?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: unknown;
  }) => OpenClawConfig;
};

export type ChannelSetupWizardPrepare = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: ChannelSetupWizardCredentialValues;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
}) =>
  | { cfg?: OpenClawConfig; credentialValues?: ChannelSetupWizardCredentialValues }
  | void
  | Promise<{ cfg?: OpenClawConfig; credentialValues?: ChannelSetupWizardCredentialValues } | void>;

export type ChannelSetupWizardFinalize = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: ChannelSetupWizardCredentialValues;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  forceAllowFrom: boolean;
}) =>
  | { cfg?: OpenClawConfig; credentialValues?: ChannelSetupWizardCredentialValues }
  | void
  | Promise<{ cfg?: OpenClawConfig; credentialValues?: ChannelSetupWizardCredentialValues } | void>;

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
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  allowEnv?: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  inspect: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => ChannelSetupWizardCredentialState;
  shouldPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    currentValue?: string;
    state: ChannelSetupWizardCredentialState;
  }) => boolean | Promise<boolean>;
  applyUseEnv?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    value: unknown;
    resolvedValue: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardAllowFromEntry = {
  input: string;
  resolved: boolean;
  id: string | null;
};

export type ChannelSetupWizardAllowFrom = {
  helpTitle?: string;
  helpLines?: string[];
  credentialInputKey?: keyof ChannelSetupInput;
  message: string;
  placeholder?: string;
  invalidWithoutCredentialNote?: string;
  parseInputs?: (raw: string) => string[];
  parseId: (raw: string) => string | null;
  resolveEntries: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    /** Legacy alias — prefer credentialValues for multi-credential wizards. */
    credentialValue?: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    entries: string[];
  }) => Promise<ChannelSetupWizardAllowFromEntry[]>;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    allowFrom: string[];
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizard = {
  channel: string;
  status: ChannelSetupWizardStatus;
  introNote?: ChannelSetupWizardNote;
  envShortcut?: ChannelSetupWizardEnvShortcut;
  /** Legacy single-credential field (kept for backward compatibility with buildChannelOnboardingAdapterFromSetupWizard). */
  credential?: ChannelSetupWizardCredential;
  /** Multi-credential list (new API used by buildChannelSetupWizardAdapterFromSetupWizard). */
  credentials?: ChannelSetupWizardCredential[];
  resolveShouldPromptAccountIds?: (params: {
    cfg: OpenClawConfig;
    options?: SetupChannelsOptions;
    shouldPromptAccountIds: boolean;
  }) => boolean;
  prepare?: ChannelSetupWizardPrepare;
  stepOrder?: "credentials-first" | "text-first";
  textInputs?: ChannelSetupWizardTextInput[];
  finalize?: ChannelSetupWizardFinalize;
  completionNote?: ChannelSetupWizardNote;
  dmPolicy?: ChannelOnboardingDmPolicy | ChannelSetupDmPolicy;
  allowFrom?: ChannelSetupWizardAllowFrom;
  groupAccess?: ChannelSetupWizardGroupAccess;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  onAccountRecorded?: (accountId: string, options?: SetupChannelsOptions) => void;
  resolveAccountIdForConfigure?: (params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    options?: SetupChannelsOptions;
    accountOverride?: string;
    shouldPromptAccountIds: boolean;
    listAccountIds: ChannelPlugin["config"]["listAccountIds"];
    defaultAccountId: string;
  }) => string | Promise<string>;
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
  // buildChannelOnboardingAdapterFromSetupWizard uses the legacy single-credential API.
  const credential = wizard.credential!;
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
      let credentialState = credential.inspect({ cfg: next, accountId });
      let resolvedCredentialValue = credentialState.resolvedValue?.trim() || undefined;
      const allowEnv = credential.allowEnv?.({ cfg: next, accountId }) ?? false;

      const credentialResult = await runSingleChannelSecretStep({
        cfg: next,
        prompter,
        providerHint: credential.providerHint,
        credentialLabel: credential.credentialLabel,
        secretInputMode: options?.secretInputMode,
        accountConfigured: credentialState.accountConfigured,
        hasConfigToken: credentialState.hasConfiguredValue,
        allowEnv,
        envValue: credentialState.envValue,
        envPrompt: credential.envPrompt,
        keepPrompt: credential.keepPrompt,
        inputPrompt: credential.inputPrompt,
        preferredEnvVar: credential.preferredEnvVar,
        onMissingConfigured:
          credential.helpLines && credential.helpLines.length > 0
            ? async () => {
                await prompter.note(
                  credential.helpLines!.join("\n"),
                  credential.helpTitle ?? credential.credentialLabel,
                );
              }
            : undefined,
        applyUseEnv: async (currentCfg) =>
          applySetupInput({
            plugin,
            cfg: currentCfg,
            accountId,
            input: {
              [credential.inputKey]: undefined,
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
              [credential.inputKey]: value,
              useEnv: false,
            },
          }).cfg;
        },
      });

      next = credentialResult.cfg;
      credentialState = credential.inspect({ cfg: next, accountId });
      resolvedCredentialValue =
        credentialResult.resolvedValue?.trim() ||
        credentialState.resolvedValue?.trim() ||
        undefined;

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
              // Legacy single-credential path — pass empty map; callers may also use credentialValue.
              credentialValues: resolvedCredentialValue
                ? { [credential.inputKey]: resolvedCredentialValue }
                : {},
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
