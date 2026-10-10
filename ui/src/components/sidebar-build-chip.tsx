import { merge } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import {
  formatSettingsBuildLabel,
  formatSidebarBuildSubtitle,
} from "./sidebar-build-chip-format.ts";
import "./tooltip.ts";
import { renderSidebarServerDetails } from "./solid/sidebar-build-details.tsx";

export type SidebarBuildChipProps = {
  basePath?: string;
  gatewayVersion?: string | null;
  updateAttentionDismissed?: boolean;
  onNavigate?: (routeId: "about") => void;
  variant?: "identity" | "settings";
};

export function SidebarBuildChip(input: SidebarBuildChipProps) {
  const props = merge(
    { basePath: "", gatewayVersion: null, updateAttentionDismissed: false, variant: "identity" },
    input,
  );
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
          role={props.variant === "identity" ? "menuitem" : null}
          aria-label={
            props.updateAttentionDismissed
              ? `${t("aboutPage.artifactDetails")}. ${t("updates.sidebar.availableTitle")}`
              : t("aboutPage.artifactDetails")
          }
          onClick={(event: MouseEvent) => {
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
