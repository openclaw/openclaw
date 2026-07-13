import type {
  ChannelSetupPlugin,
  ChannelSetupStatus,
  ChannelSetupStatusContext,
  ChannelSetupWizard,
} from "./setup-wizard-types.js";

export async function buildChannelSetupWizardStatus(
  plugin: ChannelSetupPlugin,
  wizard: ChannelSetupWizard,
  ctx: ChannelSetupStatusContext,
): Promise<ChannelSetupStatus> {
  const accountId = ctx.accountOverrides[plugin.id];
  const configured = await wizard.status.resolveConfigured({ cfg: ctx.cfg, accountId });
  const statusLines = (await wizard.status.resolveStatusLines?.({
    cfg: ctx.cfg,
    accountId,
    configured,
  })) ?? [
    `${plugin.meta.label}: ${configured ? wizard.status.configuredLabel : wizard.status.unconfiguredLabel}`,
  ];
  const selectionHint =
    (await wizard.status.resolveSelectionHint?.({
      cfg: ctx.cfg,
      accountId,
      configured,
    })) ?? (configured ? wizard.status.configuredHint : wizard.status.unconfiguredHint);
  const quickstartScore =
    (await wizard.status.resolveQuickstartScore?.({
      cfg: ctx.cfg,
      accountId,
      configured,
    })) ?? (configured ? wizard.status.configuredScore : wizard.status.unconfiguredScore);
  return {
    channel: plugin.id,
    configured,
    statusLines,
    selectionHint,
    quickstartScore,
  };
}
