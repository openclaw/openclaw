import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import {
  createOptionalChannelSetupAdapter,
  createOptionalChannelSetupWizard,
} from "./optional-channel-setup.js";

export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupInput } from "../channels/plugins/types.core.js";
export type { ChannelSetupDmPolicy, ChannelSetupWizard } from "./setup.js";
export {
  DEFAULT_ACCOUNT_ID,
  createTopLevelChannelDmPolicy,
  formatDocsLink,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "./setup.js";

/** Metadata used to advertise an optional channel plugin during setup flows. */
type OptionalChannelSetupParams = {
  /** Stable channel id used by setup routes and status reporting. */
  channel: string;
  /** Human label used in install/docs guidance. */
  label: string;
  npmSpec?: string;
  docsPath?: string;
};

/** Paired setup adapter + setup wizard for channels that may not be installed yet. */
export type OptionalChannelSetupSurface = {
  /** Runtime setup adapter that reports the optional plugin as unavailable until installed. */
  setupAdapter: ChannelSetupAdapter;
  /** CLI wizard facade that shows the same unavailable/install guidance. */
  setupWizard: ChannelSetupWizard;
};

export {
  createOptionalChannelSetupAdapter,
  createOptionalChannelSetupWizard,
} from "./optional-channel-setup.js";

/** Build both optional setup surfaces from one metadata object. */
export function createOptionalChannelSetupSurface(
  params: OptionalChannelSetupParams,
): OptionalChannelSetupSurface {
  return {
    setupAdapter: createOptionalChannelSetupAdapter(params),
    setupWizard: createOptionalChannelSetupWizard(params),
  };
}
