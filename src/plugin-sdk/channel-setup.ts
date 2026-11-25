import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import {
  createOptionalChannelSetupAdapter,
  createOptionalChannelSetupWizard,
} from "./optional-channel-setup.js";
export { defineChannelSetupContract } from "../channels/plugins/setup-contract.js";

export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupInput } from "../channels/plugins/setup-input.js";
export type { ChannelSetupDmPolicy, ChannelSetupWizard } from "./setup.js";
export {
  DEFAULT_ACCOUNT_ID,
  baseUrlTextInput,
  createTopLevelChannelDmPolicy,
  defineTokenCredential,
  formatDocsLink,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "./setup.js";

/** Metadata used to advertise an optional channel plugin during setup flows. */
type OptionalChannelSetupParams = Parameters<typeof createOptionalChannelSetupAdapter>[0];

/** Paired setup adapter + setup wizard for channels that may not be installed yet. */
export type OptionalChannelSetupSurface = {
  /** Adapter that fails validation with install guidance until the plugin is installed. */
  setupAdapter: ChannelSetupAdapter;
  /** Wizard status/finalize surface that points operators to the missing plugin. */
  setupWizard: ChannelSetupWizard;
};

export {
  createOptionalChannelSetupAdapter,
  createOptionalChannelSetupWizard,
} from "./optional-channel-setup.js";

/** Build both optional setup surfaces from one metadata object. */
export function createOptionalChannelSetupSurface(
  /** Optional plugin metadata shared by the adapter and wizard. */
  params: OptionalChannelSetupParams,
): OptionalChannelSetupSurface {
  return {
    setupAdapter: createOptionalChannelSetupAdapter(params),
    setupWizard: createOptionalChannelSetupWizard(params),
  };
}
