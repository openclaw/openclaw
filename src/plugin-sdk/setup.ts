// Shared setup wizard/types/helpers for extension setup surfaces and adapters.

export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy, GroupPolicy } from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupInput } from "../channels/plugins/types.core.js";
export type { ChannelSetupDmPolicy } from "../channels/plugins/setup-wizard-types.js";
export type { ChannelSetupWizard } from "../channels/plugins/setup-wizard.js";

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { formatDocsLink } from "../terminal/links.js";
export { hasConfiguredSecretInput, normalizeSecretInputString } from "../config/types.secrets.js";

export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
export {
  addWildcardAllowFrom,
  buildSingleChannelSecretPromptState,
  mergeAllowFromEntries,
  patchChannelConfigForAccount,
  promptSingleChannelSecretInput,
  resolveSetupAccountId,
  runSingleChannelSecretStep,
  setSetupChannelEnabled,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries,
} from "../channels/plugins/setup-wizard-helpers.js";

export { formatResolvedUnresolvedNote } from "./resolution-notes.js";
