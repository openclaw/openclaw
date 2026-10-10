import type { JSX } from "@solidjs/web";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { Icon } from "./icon.tsx";

const COPY_FEEDBACK_MS = 1_500;

async function copyBuildCommit(event: Event, commit: string, idleLabel: string) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const copied = await copyToClipboard(commit);
  button.dataset.copied = copied ? "1" : "0";
  button.setAttribute("aria-label", t(copied ? "aboutPage.copiedCommit" : "common.copyFailed"));
  window.setTimeout(() => {
    if (!button.isConnected) {
      return;
    }
    delete button.dataset.copied;
    button.setAttribute("aria-label", idleLabel);
  }, COPY_FEEDBACK_MS);
}

export function renderSidebarServerDetails(
  info: ControlUiBuildInfo,
  gatewayVersion: string | null,
): JSX.Element {
  const commit = info.commit?.slice(0, 12) ?? null;
  const builtAtMs = info.builtAt ? Date.parse(info.builtAt) : Number.NaN;
  const builtAt = Number.isFinite(builtAtMs)
    ? `${formatDateTimeMs(builtAtMs, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
      })} UTC`
    : null;
  const unavailable = t("aboutPage.unavailable");
  const copyLabel = t("aboutPage.copyCommit");
  return (
    <div class="sidebar-hover-card__server-details">
      <div class="sidebar-hover-card__summary">
        {info.version ? `v${info.version}` : unavailable}
      </div>
      <dl class="sidebar-hover-card__metadata">
        <div class="sidebar-hover-card__metadata-row">
          <dt>{t("aboutPage.commit")}</dt>
          <dd class="sidebar-hover-card__metadata-value--mono sidebar-build-hover-card__commit">
            <span>{commit ?? unavailable}</span>
            {commit ? (
              <button
                type="button"
                class="sidebar-build-hover-card__copy"
                aria-label={copyLabel}
                onClick={(event: Event) => void copyBuildCommit(event, commit, copyLabel)}
              >
                <span class="sidebar-build-hover-card__copy-idle" aria-hidden="true">
                  <Icon name="copy" />
                </span>
                <span class="sidebar-build-hover-card__copy-done" aria-hidden="true">
                  <Icon name="check" />
                </span>
              </button>
            ) : null}
          </dd>
        </div>
        <div class="sidebar-hover-card__metadata-row">
          <dt>{t("aboutPage.built")}</dt>
          <dd>{builtAt ?? unavailable}</dd>
        </div>
        <div class="sidebar-hover-card__metadata-row">
          <dt>{t("aboutPage.gateway")}</dt>
          <dd>
            {gatewayVersion ? (
              <>
                <span class="sidebar-build-hover-card__gateway-state" aria-hidden="true" />
                <span class="sr-only">{t("common.connected")}</span>
              </>
            ) : null}
            {gatewayVersion ?? unavailable}
          </dd>
        </div>
      </dl>
    </div>
  );
}
