import { action, createMemo, createSignal, Show } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import "./tooltip.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import {
  formatSettingsBuildLabel,
  formatSidebarBuildSubtitle,
} from "./sidebar-build-chip-format.ts";
import { Icon } from "./solid/icon.tsx";
import type { MenuItemBindings } from "./solid/menu.tsx";

export function SidebarBuildChip(props: {
  basePath: string;
  gatewayVersion: string | null;
  onNavigate?: (routeId: "about") => void;
  variant: "identity" | "settings";
  menuAttributes?: MenuItemBindings;
  copyButtonRef?: (element: HTMLButtonElement) => void;
}) {
  const text = createMemo(() =>
    props.variant === "settings"
      ? formatSettingsBuildLabel(CONTROL_UI_BUILD_INFO, props.gatewayVersion)
      : formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO),
  );
  function renderSidebarServerDetails() {
    const info = CONTROL_UI_BUILD_INFO;
    const gatewayVersion = props.gatewayVersion;
    const copyButtonRef = props.copyButtonRef;
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
              {commit ? <BuildCommitCopy commit={commit} buttonRef={copyButtonRef} /> : null}
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

  return (
    <openclaw-sidebar-build-chip style={{ display: "contents" }}>
      <Show when={text()}>
        {(label) => (
          <openclaw-tooltip class="sidebar-hover-tooltip" prop:delay={600} prop:closeDelay={300}>
            <a
              {...props.menuAttributes}
              class="sidebar-footer-build"
              href={pathForRoute("about", props.basePath)}
              role={props.variant === "identity" ? "menuitem" : undefined}
              aria-label={t("aboutPage.artifactDetails")}
              onClick={(event) => {
                const onClick = props.menuAttributes?.onClick;
                if (onClick) {
                  onClick(event);
                  return;
                }
                handleNavigationClick(event, () => props.onNavigate?.("about"));
              }}
            >
              <span class="sidebar-footer-build__text">{label()}</span>
            </a>
            <div slot="content" class="sidebar-hover-card sidebar-build-hover-card">
              {renderSidebarServerDetails()}
            </div>
          </openclaw-tooltip>
        )}
      </Show>
    </openclaw-sidebar-build-chip>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-build-chip": HTMLAttributes<HTMLElement>;
    }
  }
}

const COPY_FEEDBACK_MS = 1_500;

function BuildCommitCopy(props: {
  commit: string;
  buttonRef?: (element: HTMLButtonElement) => void;
}) {
  const [copied, setCopied] = createSignal<boolean | undefined>(undefined);
  const reset = createTimeout(() => setCopied(undefined), COPY_FEEDBACK_MS);
  const copy = action(async function* (button: HTMLButtonElement) {
    const result = await copyToClipboard(props.commit, () => button.isConnected);
    yield;
    if (!button.isConnected) {
      return;
    }
    setCopied(result);
    reset.schedule();
  });
  return (
    <button
      ref={(element) => props.buttonRef?.(element)}
      type="button"
      class="sidebar-build-hover-card__copy"
      data-copied={copied() === undefined ? undefined : copied() ? "1" : "0"}
      aria-label={
        copied() === undefined
          ? t("aboutPage.copyCommit")
          : t(copied() ? "aboutPage.copiedCommit" : "common.copyFailed")
      }
      onClick={(event) => void copy(event.currentTarget)}
    >
      <span class="sidebar-build-hover-card__copy-idle" aria-hidden="true">
        <Icon name="copy" />
      </span>
      <span class="sidebar-build-hover-card__copy-done" aria-hidden="true">
        <Icon name="check" />
      </span>
    </button>
  );
}
