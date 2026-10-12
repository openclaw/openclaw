// Owns automatic campaign admission and apply policy for discovered targets.
import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import { isGatewayExternallySupervised } from "./gateway-supervision.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import { normalizeUpdateChannel, resolveEffectiveUpdateChannel } from "./update-channels.js";
import type { UpdateCheckLifecycle } from "./update-check-lifecycle.js";
import { devUpdateTargetFromGitTarget } from "./update-dev-target.js";
import type { StartupInstallStatus } from "./update-install-status.types.js";
import { runCampaignUpdate, type AutoUpdateRunner } from "./update-startup-auto-run.js";
import { getUpdateSchedule, withoutUpdateCampaign } from "./update-status-state.js";

export function createUpdateCampaignPublisher(params: {
  lifecycle: UpdateCheckLifecycle;
  campaign: UpdateCampaignController;
  getConfig: () => OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  runAuto: AutoUpdateRunner;
  signal: AbortSignal;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
  onUpdateRunCreated?: () => void;
  onAttempt: (version: string) => void;
  setSchedule: (schedule: UpdateScheduleState) => void;
}) {
  return (
    target: NonNullable<UpdateScheduleState["target"]>,
    installStatus: StartupInstallStatus,
    channel: "stable" | "beta" | "dev",
    tag: string,
  ) => {
    const { root, status } = installStatus;
    const canApply = () => {
      const current = params.getConfig();
      return (
        current.update?.auto?.enabled === true &&
        current.update?.checkOnStart !== false &&
        !isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) &&
        !isGatewayExternallySupervised() &&
        resolveEffectiveUpdateChannel({
          configChannel: normalizeUpdateChannel(current.update?.channel),
          currentVersion: VERSION,
          ...installStatus.status,
        }).channel === channel
      );
    };
    if (!params.lifecycle.isCurrent() || params.signal.aborted || !canApply()) {
      return;
    }
    const onCampaignChange = (campaign: UpdateScheduleState["campaign"] | undefined) => {
      const current = getUpdateSchedule();
      if (!current || current.channel !== channel) {
        return;
      }
      const loggedTarget =
        current.target?.kind === "package"
          ? current.target.version
          : current.target?.kind === "git"
            ? {
                upstreamSha: current.target.upstreamSha,
                commitsBehind: current.target.commitsBehind,
              }
            : undefined;
      if (campaign) {
        params.log.info(`update campaign ${campaign.state}`, {
          campaignId: campaign.id,
          state: campaign.state,
          channel,
          ...(loggedTarget === undefined ? {} : { target: loggedTarget }),
          ...(campaign.applyAtMs === undefined ? {} : { applyAtMs: campaign.applyAtMs }),
          ...(campaign.holdUntilMs === undefined ? {} : { holdUntilMs: campaign.holdUntilMs }),
          forceAtMs: campaign.forceAtMs,
        });
      } else {
        params.log.info("update campaign ended", {
          ...(current.campaign?.id ? { campaignId: current.campaign.id } : {}),
          channel,
          ...(loggedTarget === undefined ? {} : { target: loggedTarget }),
        });
      }
      params.setSchedule(campaign ? { ...current, campaign } : withoutUpdateCampaign(current));
    };
    params.campaign.announce({
      target,
      inspect: params.activeWorkInspectors,
      onChange: onCampaignChange,
      apply: ({ forced, target: admittedTarget }) =>
        params.lifecycle.run(() =>
          runCampaignUpdate({
            channel,
            mode: admittedTarget.kind === "git" ? "git" : status.packageManager,
            version:
              admittedTarget.kind === "git" ? admittedTarget.upstreamSha : admittedTarget.version,
            tag,
            forced,
            root: root ?? status.root ?? undefined,
            ...(admittedTarget.kind === "git"
              ? { devTarget: devUpdateTargetFromGitTarget(admittedTarget) }
              : {}),
            log: params.log,
            runAuto: params.runAuto,
            canApply,
            onAttempt: params.onAttempt,
            campaign: params.campaign,
            onUpdateRunCreated: params.onUpdateRunCreated,
            signal: params.signal,
          }),
        ),
    });
  };
}
