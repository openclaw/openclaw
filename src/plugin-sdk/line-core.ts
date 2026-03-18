export type { OpenClawConfig } from "../config/config.js";
export type { LineConfig } from "../line/types.js";
export {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
  setSetupChannelEnabled,
  setTopLevelChannelDmPolicyWithAllowFrom,
  splitSetupEntries,
} from "./setup.js";
export type { ChannelSetupAdapter, ChannelSetupDmPolicy, ChannelSetupWizard } from "./setup.js";
export {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../line/accounts.js";
