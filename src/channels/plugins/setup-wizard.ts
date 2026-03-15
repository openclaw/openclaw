import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
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

export type ChannelSetupWizardStatus = {
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint?: string;
  unconfiguredHint?: string;
  configuredScore?: number;
  unconfiguredScore?: number;
  resolveConfigured: (params: { cfg: OpenClawConfig }) => boolean | Promise<boolean>;
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
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  allowEnv?: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  inspect: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => ChannelSetupWizardCredentialState;
};

export type ChannelSetupWizardAllowFromEntry = {
  input: string;
  resolved: boolean;
  id: string | null;
};

export type ChannelSetupWizardAllowFrom = {
  helpTitle?: string;
  helpLines?: string[];
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseInputs?: (raw: string) => string[];
  parseId: (raw: string) => string | null;
  resolveEntries: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValue?: string;
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
  credential: ChannelSetupWizardCredential;
  dmPolicy?: ChannelOnboardingDmPolicy;
  allowFrom?: ChannelSetupWizardAllowFrom;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  onAccountRecorded?: ChannelOnboardingAdapter["onAccountRecorded"];
};

type ChannelSetupWizardPlugin = Pick<ChannelPlugin, "id" | "meta" | "config" | "setup">;

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
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        plugin.config.listAccountIds(cfg)[0] ??
        DEFAULT_ACCOUNT_ID;
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
      let credentialState = wizard.credential.inspect({ cfg: next, accountId });
      let resolvedCredentialValue = credentialState.resolvedValue?.trim() || undefined;
      const allowEnv = wizard.credential.allowEnv?.({ cfg: next, accountId }) ?? false;

      const credentialResult = await runSingleChannelSecretStep({
        cfg: next,
        prompter,
        providerHint: wizard.credential.providerHint,
        credentialLabel: wizard.credential.credentialLabel,
        secretInputMode: options?.secretInputMode,
        accountConfigured: credentialState.accountConfigured,
        hasConfigToken: credentialState.hasConfiguredValue,
        allowEnv,
        envValue: credentialState.envValue,
        envPrompt: wizard.credential.envPrompt,
        keepPrompt: wizard.credential.keepPrompt,
        inputPrompt: wizard.credential.inputPrompt,
        preferredEnvVar: wizard.credential.preferredEnvVar,
        onMissingConfigured:
          wizard.credential.helpLines && wizard.credential.helpLines.length > 0
            ? async () => {
                await prompter.note(
                  wizard.credential.helpLines!.join("\n"),
                  wizard.credential.helpTitle ?? wizard.credential.credentialLabel,
                );
              }
            : undefined,
        applyUseEnv: async (currentCfg) =>
          applySetupInput({
            plugin,
            cfg: currentCfg,
            accountId,
            input: {
              [wizard.credential.inputKey]: undefined,
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
              [wizard.credential.inputKey]: value,
              useEnv: false,
            },
          }).cfg;
        },
      });

      next = credentialResult.cfg;
      credentialState = wizard.credential.inspect({ cfg: next, accountId });
      resolvedCredentialValue =
        credentialResult.resolvedValue?.trim() ||
        credentialState.resolvedValue?.trim() ||
        undefined;

      if (forceAllowFrom && wizard.allowFrom) {
        const allowFrom = wizard.allowFrom;
        if (allowFrom.helpLines && allowFrom.helpLines.length > 0) {
          await prompter.note(
            allowFrom.helpLines.join("\n"),
            allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
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
          message: allowFrom.message,
          placeholder: allowFrom.placeholder,
          label: allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          parseInputs: allowFrom.parseInputs ?? splitOnboardingEntries,
          parseId: allowFrom.parseId,
          invalidWithoutTokenNote: allowFrom.invalidWithoutCredentialNote,
          resolveEntries: async ({ entries }) =>
            allowFrom.resolveEntries({
              cfg: next,
              accountId,
              credentialValue: resolvedCredentialValue,
              entries,
            }),
        });
        next = await allowFrom.apply({
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
