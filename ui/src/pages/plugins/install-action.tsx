import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUnit } from "../../lib/format.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { createInterval } from "../../lib/reactive/timers.ts";
import { generateUUID } from "../../lib/uuid.ts";
import "./install-action.css";
import type { PluginInstallProgress } from "./install-progress.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export type PluginInstallActionHandle = {
  readonly open: boolean;
  dismiss(): void;
};

export type PluginInstallActionProps = {
  registerInstallAction?: (action: PluginInstallActionHandle) => () => void;
  onButtonRef?: (button: HTMLButtonElement) => void;
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

type PluginInstallActionElement = HTMLElement & { dismiss(): void };

export function PluginInstallAction(props: PluginInstallActionProps): SolidJSX.Element {
  let host!: HTMLElement;
  const [button, setButton] = createSignal<HTMLButtonElement>();
  const [open, setOpen] = createSignal(false);
  let popover: PopoverHandle | undefined;
  const [now, setNow] = createSignal(Date.now());
  const idle = createMemo(() => !props.progress && !props.busy);
  // An idle action retires pinning; progress updates preserve the operator's choice.
  const [pinned, setPinned] = createSignal<boolean>((previous) => !idle() && Boolean(previous));
  let hovering = false;
  const progressId = `plugin-install-progress-${generateUUID()}`;
  const dismiss = () => {
    setPinned(false);
    popover?.overlay.request(false, "return");
  };
  onSettled(() => {
    const unregister = props.registerInstallAction?.({
      get open() {
        return open() && Boolean(props.progress);
      },
      dismiss,
    });
    return () => {
      unregister?.();
      popover = undefined;
    };
  });
  const running = createMemo(() => props.progress && props.progress.finishedAt === undefined);
  createInterval(
    () => setNow(Date.now()),
    () => (running() ? 1000 : undefined),
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
    <openclaw-plugin-install-action
      open={open() && Boolean(props.progress)}
      ref={(element) => {
        host = Object.assign(element, { dismiss });
      }}
    >
      <span
        class="plugin-install-action"
        onMouseEnter={() => {
          hovering = true;
          popover?.show();
        }}
        onMouseLeave={() => {
          hovering = false;
          if (!pinned() && !host.contains(document.activeElement)) {
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
            !pinned() &&
            !hovering &&
            !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))
          ) {
            popover?.hide();
          }
        }}
      >
        <button
          ref={[setButton, props.onButtonRef]}
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
              const nextPinned = !pinned();
              setPinned(nextPinned);
              if (nextPinned) {
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
              if (hovering || pinned() || host.contains(document.activeElement)) {
                handle.show();
              }
            }}
            dismissOutsidePointer={false}
            dismissOutsideFocus={false}
            onOpenChange={(value) => {
              if (!value) {
                setPinned(false);
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
                      class={[
                        "plugin-install-progress__activity",
                        `plugin-install-progress__activity--${activity.status}`,
                      ]}
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
    </openclaw-plugin-install-action>
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-install-action": PluginInstallActionElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-plugin-install-action": HTMLAttributes<HTMLElement> & { open?: boolean };
    }
  }
}
