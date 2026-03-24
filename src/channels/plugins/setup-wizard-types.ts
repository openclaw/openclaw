// Shared types for channel setup wizard components.
// Split out from setup-wizard.ts to avoid circular imports with setup-wizard-helpers.ts.
import type { OpenClawConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

/** DM policy configuration adapter for a channel setup wizard. */
export type ChannelSetupDmPolicy = {
  /** Human-readable label for this channel (e.g. "Discord"). */
  label: string;
  /** Channel identifier (e.g. "discord"). */
  channel: string;
  /** Config path key for the DM policy field. */
  policyKey: string;
  /** Config path key for the allow-from list. */
  allowFromKey: string;
  /** Get the current DM policy from config. */
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  /** Apply the new DM policy to config and return the updated config. */
  setPolicy: (cfg: OpenClawConfig, policy: DmPolicy) => OpenClawConfig;
  /**
   * Optional interactive prompt to collect the allow-from list.
   * Called during wizard flows that support allow-from configuration.
   */
  promptAllowFrom?: (params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    accountId: string;
  }) => Promise<OpenClawConfig>;
};

/** Params passed to the account-id prompter. */
export type PromptAccountIdParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  defaultAccountId?: string;
  listAccountIds: (cfg: OpenClawConfig) => string[];
};

/** A function that prompts the user to select or enter an account ID. */
export type PromptAccountId = (params: PromptAccountIdParams) => Promise<string>;

/**
 * Adapter interface for plugging a setup wizard into the unified channel setup surface.
 * Channels may implement this to customize how the setup flow is rendered or delegated.
 */
export type ChannelSetupWizardAdapter = {
  /** Unique adapter identifier (matches channel id). */
  channelId: string;
};
