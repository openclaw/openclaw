import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUnit } from "../../lib/format.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import "./custom-elements.ts";
import "./install-action.css";
import type { PluginInstallProgress } from "./install-progress.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export type PluginInstallActionProps = {
  progress?: PluginInstallProgress;
  busy?: boolean;
  disabled?: boolean;
  pluginName?: string;
  buttonClass?: string;
  primary?: boolean;
  actionLabel?: string;
  busyLabel?: string;
  onInstall?: () => void;
};

type PluginInstallActionMethods = { dismiss(): void };
export type PluginInstallActionElement = SolidBridgeElement<
  PluginInstallActionProps,
  PluginInstallActionMethods
>;
const dismissers = new WeakMap<HTMLElement, () => void>();

function InstallActionContent(
  props: PluginInstallActionProps,
  host: PluginInstallActionElement,
): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement>();
  const [open, setOpen] = createSignal(false);
  let popover: PopoverHandle | undefined;
  const [now, setNow] = createSignal(Date.now());
  let pinned = false;
  let hovering = false;
  const progressId = `plugin-install-progress-${generateUUID()}`;
  const dismiss = () => {
    pinned = false;
    popover?.overlay.request(false, "return");
  };
  dismissers.set(host, dismiss);
  onCleanup(() => dismissers.delete(host));
  createEffect(
    () => open() && Boolean(props.progress),
    (expanded) => {
      host.toggleAttribute("open", expanded);
    },
  );
  createEffect(
    () => props.progress && props.progress.finishedAt === undefined,
    (running) => {
      if (!running) {
        return undefined;
      }
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    },
  );
  createEffect(
    () => !props.progress && !props.busy,
    (idle) => {
      if (idle) {
        pinned = false;
      }
    },
  );
  const progress = () => props.progress;
  const failed = () => props.progress?.finishedAt !== undefined;
  const active = () => Boolean(progress()) || props.busy;
  const canInstall = () => !active() || (props.progress?.canRetry === true && !props.busy);
  const duration = () =>
    props.progress
      ? Math.max(
          0,
          Math.floor(((props.progress.finishedAt ?? now()) - props.progress.startedAt) / 1000),
        )
      : 0;
  return (
    <span
      class="plugin-install-action"
      onMouseEnter={() => {
        hovering = true;
        popover?.show();
      }}
      onMouseLeave={() => {
        hovering = false;
        if (!pinned && !host.contains(document.activeElement)) {
          popover?.hide();
        }
      }}
      onFocusIn={(event: FocusEvent) => {
        // The owner's return focus during close must not reopen the panel.
        if (
          popover?.overlay.phase !== "closing" &&
          !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))
        ) {
          popover?.show();
        }
      }}
      onFocusOut={(event: FocusEvent) => {
        if (
          !pinned &&
          !hovering &&
          !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))
        ) {
          popover?.hide();
        }
      }}
    >
      <button
        ref={setButton}
        type="button"
        class={[
          props.buttonClass,
          "plugin-install-action__button",
          {
            primary: props.primary && !failed(),
            "oc-action-primary": props.primary && !failed(),
            "oc-action-secondary": !props.primary || failed(),
            "plugin-install-action__button--failed": failed(),
          },
        ]}
        disabled={props.disabled && canInstall()}
        aria-label={
          props.pluginName && (canInstall() || failed())
            ? t(
                canInstall()
                  ? failed()
                    ? "pluginsPage.retryInstallNamed"
                    : "pluginsPage.installNamed"
                  : "pluginsPage.viewInstallStatusNamed",
                { name: props.pluginName },
              )
            : undefined
        }
        aria-busy={active() && !failed() ? "true" : undefined}
        aria-expanded={progress() ? (open() ? "true" : "false") : undefined}
        aria-controls={progress() ? progressId : undefined}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (canInstall()) {
            if (!props.disabled) {
              props.onInstall?.();
            }
          } else {
            pinned = !pinned;
            if (pinned) {
              popover?.show();
            } else {
              popover?.hide();
            }
          }
        }}
      >
        {active() && !failed() ? <span class="btn__spinner" aria-hidden="true" /> : undefined}
        {canInstall() && !failed()
          ? (props.actionLabel ?? t("pluginsPage.install"))
          : active() && !failed()
            ? (props.busyLabel ?? t("pluginsPage.installing"))
            : t(
                failed() && canInstall()
                  ? "pluginsPage.retryInstall"
                  : "pluginsPage.installProgress.viewStatus",
              )}
        {progress() ? <Icon name="chevronDown" /> : undefined}
      </button>
      {progress() && button() ? (
        <Popover
          id={progressId}
          label={t("pluginsPage.installProgress.title")}
          anchor={button()}
          class="plugin-install-action__popup"
          placement="bottom-start"
          ref={(handle) => {
            popover = handle;
            setOpen(handle.overlay.open);
            if (hovering || pinned || host.contains(document.activeElement)) {
              handle.show();
            }
          }}
          dismissOutsidePointer={false}
          dismissOutsideFocus={false}
          onOpenChange={(value) => {
            if (!value) {
              pinned = false;
            }
            setOpen(value);
          }}
        >
          <section
            class="plugin-install-progress"
            role="status"
            aria-label={t("pluginsPage.installProgress.title")}
          >
            <div class="plugin-install-progress__header">
              <strong>
                {props.progress!.failure?.title ??
                  t(
                    failed()
                      ? "pluginsPage.installProgress.stopped"
                      : "pluginsPage.installProgress.title",
                  )}
              </strong>
              <span aria-hidden="true">{formatUnit({ value: duration(), unit: "second" })}</span>
            </div>
            {props.progress!.failure && !props.progress!.canRetry ? (
              <p class="plugin-install-progress__recovery">{props.progress!.failure.recovery}</p>
            ) : undefined}
            <ol class="plugin-install-progress__activities">
              <For each={props.progress!.activities}>
                {(activity) => (
                  <li
                    class={`plugin-install-progress__activity plugin-install-progress__activity--${activity.status}`}
                  >
                    <span class="plugin-install-progress__icon" aria-hidden="true">
                      {activity.status === "completed" ? (
                        <Icon name="check" />
                      ) : activity.status === "failed" ? (
                        "!"
                      ) : undefined}
                    </span>
                    <span>
                      {t(`pluginsPage.installProgress.${activity.stage}.${activity.status}`)}
                    </span>
                  </li>
                )}
              </For>
              {failed() &&
              !props.progress!.activities.some((activity) => activity.status === "failed") ? (
                <li class="plugin-install-progress__activity plugin-install-progress__activity--failed">
                  <span class="plugin-install-progress__icon" aria-hidden="true">
                    !
                  </span>
                  <span>{t("pluginsPage.installProgress.failure")}</span>
                </li>
              ) : undefined}
            </ol>
            {props.progress!.failure ? (
              <details class="plugin-install-progress__failure">
                <summary>{t("pluginsPage.installProgress.details")}</summary>
                <p>{props.progress!.failure.detail}</p>
              </details>
            ) : undefined}
          </section>
        </Popover>
      ) : undefined}
    </span>
  );
}

export const PluginInstallAction = defineSolidBridge<
  PluginInstallActionProps,
  PluginInstallActionMethods
>("openclaw-plugin-install-action", InstallActionContent, {
  properties: {
    progress: { default: undefined, attribute: false },
    busy: { default: false, attribute: false },
    disabled: { default: false, attribute: false },
    pluginName: { default: "", attribute: false },
    buttonClass: { default: "", attribute: false },
    primary: { default: false, attribute: false },
    actionLabel: { default: undefined, attribute: false },
    busyLabel: { default: undefined, attribute: false },
    onInstall: { default: undefined, attribute: false },
  },
  methods: { dismiss: (host) => dismissers.get(host)?.() },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-install-action": PluginInstallActionElement;
  }
}
