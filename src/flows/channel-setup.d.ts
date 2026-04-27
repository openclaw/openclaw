import type { ChannelSetupWizardAdapter } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelOnboardingPostWriteHook, SetupChannelsOptions } from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export { noteChannelStatus } from "./channel-setup.status.js";
export declare function createChannelOnboardingPostWriteHookCollector(): {
    collect(hook: ChannelOnboardingPostWriteHook): void;
    drain(): ChannelOnboardingPostWriteHook[];
};
export declare function runCollectedChannelOnboardingPostWriteHooks(params: {
    hooks: ChannelOnboardingPostWriteHook[];
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
}): Promise<void>;
export declare function createChannelOnboardingPostWriteHook(params: {
    accountId?: string;
    adapter?: Pick<ChannelSetupWizardAdapter, "afterConfigWritten">;
    channel: ChannelChoice;
    previousCfg: OpenClawConfig;
}): ChannelOnboardingPostWriteHook | undefined;
export declare function setupChannels(cfg: OpenClawConfig, runtime: RuntimeEnv, prompter: WizardPrompter, options?: SetupChannelsOptions): Promise<OpenClawConfig>;
