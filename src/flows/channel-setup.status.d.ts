import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupWizardAdapter, ChannelSetupStatus, SetupChannelsOptions } from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { FlowContribution } from "./types.js";
export type ChannelStatusSummary = {
    installedPlugins: ChannelSetupPlugin[];
    catalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
    installedCatalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
    statusByChannel: Map<ChannelChoice, ChannelSetupStatus>;
    statusLines: string[];
};
export type ChannelSetupSelectionContribution = FlowContribution & {
    kind: "channel";
    surface: "setup";
    channel: ChannelChoice;
    source: "catalog" | "core" | "plugin";
};
type ChannelSetupSelectionEntry = {
    id: ChannelChoice;
    meta: {
        id: string;
        label: string;
        selectionLabel?: string;
        exposure?: {
            setup?: boolean;
        };
        showConfigured?: boolean;
        showInSetup?: boolean;
    };
};
export declare function collectChannelStatus(params: {
    cfg: OpenClawConfig;
    options?: SetupChannelsOptions;
    accountOverrides: Partial<Record<ChannelChoice, string>>;
    installedPlugins?: ChannelSetupPlugin[];
    resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<ChannelStatusSummary>;
export declare function noteChannelStatus(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    options?: SetupChannelsOptions;
    accountOverrides?: Partial<Record<ChannelChoice, string>>;
    installedPlugins?: ChannelSetupPlugin[];
    resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<void>;
export declare function noteChannelPrimer(prompter: WizardPrompter, channels: Array<{
    id: ChannelChoice;
    blurb: string;
    label: string;
}>): Promise<void>;
export declare function resolveQuickstartDefault(statusByChannel: Map<ChannelChoice, {
    quickstartScore?: number;
}>): ChannelChoice | undefined;
export declare function resolveChannelSelectionNoteLines(params: {
    cfg: OpenClawConfig;
    installedPlugins: ChannelSetupPlugin[];
    selection: ChannelChoice[];
}): string[];
export declare function resolveChannelSetupSelectionContributions(params: {
    entries: ChannelSetupSelectionEntry[];
    statusByChannel: Map<ChannelChoice, {
        selectionHint?: string;
    }>;
    resolveDisabledHint: (channel: ChannelChoice) => string | undefined;
}): ChannelSetupSelectionContribution[];
export {};
