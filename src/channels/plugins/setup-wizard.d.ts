import type { ChannelSetupPlugin, ChannelSetupWizardAdapter, ChannelSetupWizard } from "./setup-wizard-types.js";
export type { ChannelSetupWizard, ChannelSetupWizardAllowFrom, ChannelSetupWizardAllowFromEntry, ChannelSetupWizardCredential, ChannelSetupWizardCredentialState, ChannelSetupWizardEnvShortcut, ChannelSetupWizardFinalize, ChannelSetupWizardGroupAccess, ChannelSetupWizardNote, ChannelSetupWizardPrepare, ChannelSetupWizardStatus, ChannelSetupWizardTextInput, } from "./setup-wizard-types.js";
type ChannelSetupWizardPlugin = ChannelSetupPlugin;
export declare function buildChannelSetupWizardAdapterFromSetupWizard(params: {
    plugin: ChannelSetupWizardPlugin;
    wizard: ChannelSetupWizard;
}): ChannelSetupWizardAdapter;
