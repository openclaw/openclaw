import { createMemo } from "solid-js";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
} from "../../app/update-schedule-projection.ts";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import type { UpdatesViewProps } from "./updates.tsx";

export function UpdatesStatus(props: UpdatesViewProps) {
  const status = createMemo(() => {
    getLocale();
    const run = props.update.updateRun;
    const running = run?.status === "running";
    const campaign = props.update.updateSchedule?.campaign;
    const campaignLabel = formatUpdateCampaignLabel(props.update.updateSchedule, props.nowMs);
    const target = formatUpdateTargetLabel(
      props.update.updateSchedule,
      props.update.updateAvailable,
    );
    let kind: "muted" | "accent" | "warn" | "danger" | "ok" = "muted";
    let label: string;
    if (running) {
      kind = "accent";
      label = t("updates.page.activePhase", { phase: t(`updates.run.phase.${run.phase}`) });
    } else if (props.update.updateStatusRefreshing && !props.updateBusy) {
      label = t("updates.page.checking");
    } else if (props.update.updateStatusCheckBanner && !props.updateBusy) {
      kind = "warn";
      label = props.update.updateStatusCheckBanner.text;
    } else if (campaignLabel) {
      kind = campaign?.state === "waiting-for-idle" ? "warn" : "accent";
      label = campaignLabel;
    } else if (props.update.updateStatusBanner) {
      kind =
        props.update.updateStatusBanner.tone === "danger"
          ? "danger"
          : props.update.updateStatusBanner.tone === "warn"
            ? "warn"
            : "accent";
      label = props.update.updateStatusBanner.text;
    } else if (props.update.updateSchedule?.install?.kind === "git") {
      const git = props.update.updateSchedule.install.git;
      if (!git) {
        label = t("updates.page.statusUnavailable");
      } else if (git.status === "current") {
        kind = "ok";
        label = t("updates.page.upToDate");
      } else if (git.status === "behind") {
        kind = "accent";
        label = t("updates.page.available", {
          target: t(
            git.commitsBehind === 1
              ? "updates.target.commitBehind"
              : "updates.target.commitsBehind",
            { count: String(git.commitsBehind) },
          ),
        });
      } else if (git.status === "ahead") {
        label = t(
          git.commitsAhead === 1 ? "updates.page.gitCommitAhead" : "updates.page.gitCommitsAhead",
          { count: String(git.commitsAhead) },
        );
      } else if (git.status === "diverged") {
        kind = "warn";
        label = t("updates.page.gitDiverged", {
          ahead: String(git.commitsAhead),
          behind: String(git.commitsBehind),
        });
      } else {
        kind = "warn";
        label =
          git.reason === "fetch-failed"
            ? t("updates.page.gitFetchFailed")
            : git.reason === "no-upstream"
              ? t("updates.page.gitNoUpstream")
              : t("updates.page.gitComparisonFailed");
      }
    } else if (target) {
      kind = "accent";
      label = t("updates.page.available", { target });
    } else if (props.update.updateSchedule?.install?.kind === "package") {
      kind = "ok";
      label = t("updates.page.upToDate");
    } else {
      label = t("updates.page.statusUnavailable");
    }
    return {
      kind,
      label,
      checkFailed: Boolean(
        props.update.updateStatusCheckBanner &&
        !props.update.updateStatusRefreshing &&
        !props.updateBusy,
      ),
      countdown:
        !running && (campaign?.state === "waiting-for-idle" || campaign?.state === "countdown"),
    };
  });
  return (
    <span
      class={status().checkFailed ? "updates-status-check-failed" : undefined}
      role={status().countdown ? "timer" : undefined}
      aria-live={status().countdown ? "off" : undefined}
    >
      <SettingsStatus kind={status().kind} label={status().label} dot={false} />
    </span>
  );
}
