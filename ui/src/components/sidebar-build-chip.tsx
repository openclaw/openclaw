import type { JSX } from "@solidjs/web";
import { pathForRoute } from "../app-route-paths.ts";
import { CONTROL_UI_BUILD_INFO, type ControlUiBuildInfo } from "../build-info.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import "./tooltip.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import {
  formatSettingsBuildLabel,
  formatSidebarBuildSubtitle,
} from "./sidebar-build-chip-format.ts";
import { Icon } from "./solid/icon.tsx";

export type SidebarBuildChipProps = {
  basePath: string;
  gatewayVersion: string | null;
  updateAttentionDismissed: boolean;
  onNavigate?: (routeId: "about") => void;
  variant: "identity" | "settings";
};

function SidebarBuildChipContent(props: SidebarBuildChipProps, host: HTMLElement) {
  host.style.display = "contents";
  function renderContent() {
    const text =
      props.variant === "settings" || props.updateAttentionDismissed
        ? formatSettingsBuildLabel(CONTROL_UI_BUILD_INFO, props.gatewayVersion)
        : formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO);
    if (!text && !props.updateAttentionDismissed) {
      return null;
    }
    return (
      <openclaw-tooltip class="sidebar-hover-tooltip" prop:delay={600} prop:closeDelay={300}>
        <a
          class="sidebar-footer-build"
          href={pathForRoute("about", props.basePath)}
          role={props.variant === "identity" ? "menuitem" : undefined}
          aria-label={
            props.updateAttentionDismissed
              ? `${t("aboutPage.artifactDetails")}. ${t("updates.sidebar.availableTitle")}`
              : t("aboutPage.artifactDetails")
          }
          onClick={(event) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            props.onNavigate?.("about");
          }}
        >
          {text ? <span class="sidebar-footer-build__text">{text}</span> : null}
          {props.updateAttentionDismissed ? (
            <span class="agent-select__badge sidebar-footer-build__update">
              {t("updates.sidebar.availableTitle")}
            </span>
          ) : null}
        </a>
        <div slot="content" class="sidebar-hover-card sidebar-build-hover-card">
          {renderSidebarServerDetails(CONTROL_UI_BUILD_INFO, props.gatewayVersion)}
        </div>
      </openclaw-tooltip>
    );
  }
  return <>{renderContent()}</>;
}

export const SidebarBuildChip = defineSolidBridge<SidebarBuildChipProps>(
  "openclaw-sidebar-build-chip",
  SidebarBuildChipContent,
  {
    properties: {
      basePath: { default: "", attribute: false },
      gatewayVersion: { default: null, attribute: false },
      updateAttentionDismissed: { default: false, attribute: false },
      onNavigate: { default: undefined, attribute: false },
      variant: { default: "identity", attribute: false },
    },
  },
);

const COPY_FEEDBACK_MS = 1_500;

async function copyBuildCommit(button: HTMLButtonElement, commit: string, idleLabel: string) {
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

function renderSidebarServerDetails(
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
                onClick={(event) => void copyBuildCommit(event.currentTarget, commit, copyLabel)}
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
