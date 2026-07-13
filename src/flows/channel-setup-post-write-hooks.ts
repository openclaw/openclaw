import type {
  ChannelOnboardingPostWriteHook,
  ChannelSetupWizardAdapter,
} from "../channels/plugins/setup-wizard-types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";

export function createChannelOnboardingPostWriteHookCollector() {
  const hooks = new Map<string, ChannelOnboardingPostWriteHook>();
  return {
    collect(hook: ChannelOnboardingPostWriteHook) {
      hooks.set(`${hook.channel}:${hook.accountId}`, hook);
    },
    drain(): ChannelOnboardingPostWriteHook[] {
      const next = [...hooks.values()];
      hooks.clear();
      return next;
    },
  };
}

export async function runCollectedChannelOnboardingPostWriteHooks(params: {
  hooks: ChannelOnboardingPostWriteHook[];
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<void> {
  for (const hook of params.hooks) {
    await params.beforePersistentEffect?.();
    try {
      await hook.run({ cfg: params.cfg, runtime: params.runtime });
    } catch (err) {
      const message = formatErrorMessage(err);
      params.runtime.error(
        `Channel ${hook.channel} post-setup warning for "${hook.accountId}": ${message}`,
      );
    }
  }
}

export function createChannelOnboardingPostWriteHook(params: {
  accountId?: string;
  adapter?: Pick<ChannelSetupWizardAdapter, "afterConfigWritten">;
  channel: ChannelChoice;
  previousCfg: OpenClawConfig;
}): ChannelOnboardingPostWriteHook | undefined {
  if (!params.accountId || !params.adapter?.afterConfigWritten) {
    return undefined;
  }
  return {
    channel: params.channel,
    accountId: params.accountId,
    run: async ({ cfg, runtime }) =>
      await params.adapter?.afterConfigWritten?.({
        previousCfg: params.previousCfg,
        cfg,
        accountId: params.accountId!,
        runtime,
      }),
  };
}
