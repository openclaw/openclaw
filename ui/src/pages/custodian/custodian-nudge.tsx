import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { CustodianEventNudge } from "./event-nudge.ts";

function eventNudgeText(nudge: CustodianEventNudge): string {
  if (nudge.kind === "config-reload") {
    return t("custodian.nudge.configReload");
  }
  const channel = nudge.channelLabel ?? t("custodian.nudge.channelFallback");
  if (nudge.kind === "channel-auth") {
    return t("custodian.nudge.channelAuth", { channel });
  }
  if (nudge.kind === "channel-disconnected") {
    return t("custodian.nudge.channelDisconnected", { channel });
  }
  return t("custodian.nudge.channelDegraded", { channel });
}

function NudgeDismiss(props: { label: string; onDismiss: () => void }) {
  return (
    <button
      class="custodian__nudge-dismiss"
      type="button"
      aria-label={t(props.label)}
      onClick={() => props.onDismiss()}
    >
      <Icon name="x" />
    </button>
  );
}

export function CustodianEventNudgeView(props: {
  nudge: CustodianEventNudge;
  disabled: boolean;
  onSend: () => void;
  onDismiss: () => void;
}) {
  return (
    <div class="custodian__nudge" role="status">
      <button
        class="custodian__nudge-action"
        type="button"
        disabled={props.disabled}
        onClick={() => props.onSend()}
      >
        {eventNudgeText(props.nudge)}
      </button>
      <NudgeDismiss label="custodian.nudge.dismiss" onDismiss={props.onDismiss} />
    </div>
  );
}

export function CustodianChannelOnboardingNudge(props: {
  error: boolean;
  retrying: boolean;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      class="custodian__nudge custodian__nudge--channel-onboarding"
      role={props.error ? "alert" : "status"}
    >
      <div class="custodian__nudge-copy">
        <strong>
          {t(
            props.error
              ? "custodian.nudge.channelStatusErrorTitle"
              : "custodian.nudge.channelSetupTitle",
          )}
        </strong>
        <span>
          {t(
            props.error
              ? "custodian.nudge.channelStatusErrorBody"
              : "custodian.nudge.channelSetupBody",
          )}
        </span>
      </div>
      <button
        class="btn btn--sm primary custodian__nudge-cta"
        type="button"
        disabled={props.error && props.retrying}
        onClick={() => props.onAction()}
      >
        {t(
          props.error
            ? props.retrying
              ? "common.loading"
              : "common.retry"
            : "custodian.nudge.channelSetupAction",
        )}
      </button>
      <NudgeDismiss label="custodian.nudge.channelSetupDismiss" onDismiss={props.onDismiss} />
    </div>
  );
}
