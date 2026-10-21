import { createMemo, createSignal, createUniqueId, Show, useContext } from "solid-js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import { GitDiffValues } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { sessionPullRequestStateIcons } from "../../../lib/session-pull-request-presentation.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { showToast } from "../../../lib/toast.ts";
import {
  ChecksRows,
  StatusWarning,
  STATE_LABEL_KEYS,
  type ChatPullRequestsProps,
} from "./chat-pull-request-shared.tsx";
import "./chat-ci-details.ts";
import "./chat-ci-automation-control.ts";

const CHECK_ROLLUP = {
  failing: ["failed", "chat.pullRequests.checksFailed", "circleX"],
  pending: ["running", "chat.pullRequests.checksRunning", "loader"],
  passing: ["passed", "chat.pullRequests.checksPassed", "check"],
} as const;

export function PullRequestActions(props: {
  label: string;
  disabled: boolean;
  presented: PresentationValue;
  dismissed?: boolean;
  onDismiss: () => void;
  pullRequest: ControlUiSessionPullRequest;
  owner: ChatPullRequestsProps;
}) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const parentPresented = useContext(ContentPresentation);
  let menu: MenuHandle | undefined;
  const [copying, setCopying] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const [page, setPage] = createSignal<"home" | "checks" | "monitoring">("home");
  let backButton: HTMLButtonElement | undefined;
  let checksButton: HTMLButtonElement | undefined;
  let monitoringButton: HTMLButtonElement | undefined;
  const navigate = (next: "checks" | "monitoring") => {
    setPage(next);
    queueMicrotask(() => backButton?.focus());
  };
  const back = () => {
    const previous = page();
    setPage("home");
    queueMicrotask(() => (previous === "checks" ? checksButton : monitoringButton)?.focus());
  };
  const [menuOpen, setMenuOpen] = createSignal(false);
  const presentation = createMemo(() => projectPresentation(props.presented));
  const presented = () => parentPresented() && !props.dismissed && presentation().read();
  const copy = async () => {
    if (copying()) {
      return;
    }
    const url = props.pullRequest.url;
    setCopying(true);
    setCopyFailed(false);
    const current = () =>
      presented() && menu?.overlay.open === true && props.pullRequest.url === url;
    const copied = await copyToClipboard(url, current);
    setCopying(false);
    if (!current()) {
      return;
    }
    if (copied) {
      menu?.close();
      showToast({ message: t("chat.pullRequests.linkCopied") });
    } else {
      setCopyFailed(true);
    }
  };
  const checks = () => props.pullRequest.checks;
  const rollup = () => {
    const current = checks();
    if (!current) {
      return undefined;
    }
    const [state, label, icon] = CHECK_ROLLUP[current.state];
    if (current[state] > 0) {
      return {
        label: t(label),
        count: current[state],
        icon,
        state,
      } as const;
    }
    if (current.skipped > 0) {
      return {
        label: t("chat.pullRequests.checksSkipped"),
        count: current.skipped,
        icon: "circle",
        state: "skipped",
      } as const;
    }
    return undefined;
  };
  // The enclosing page supplies visibility; CI owners retain requests, errors and mutations.
  const checksContent = (
    <div
      class="chat-pr-menu__page"
      hidden={page() !== "checks"}
      aria-label={t("chat.pullRequests.checksTitle")}
    >
      <div class="chat-pr-menu__checks-heading">
        <span>{t("chat.pullRequests.checksTitle")}</span>
        <div class="chat-pr-menu__checks-totals">
          <ChecksRows checks={checks()} runningFirst />
        </div>
      </div>
      <openclaw-chat-ci-details
        prop:pullRequest={props.pullRequest}
        prop:gateway={props.owner.gateway}
        prop:sessionKey={props.owner.sessionKey ?? ""}
        prop:presented={presented() && menuOpen() && page() === "checks"}
        prop:inline={true}
        prop:menuControls={true}
        prop:controls={controls}
      />
    </div>
  );
  const monitoringContent = (
    <div
      class="chat-pr-menu__page"
      hidden={page() !== "monitoring"}
      aria-label={t("chat.pullRequests.ciMonitoring")}
    >
      <div class="chat-pr-menu__caption">{t("chat.pullRequests.ciMonitoring")}</div>
      <openclaw-chat-ci-automation
        prop:pullRequest={props.pullRequest}
        prop:gateway={props.owner.gateway}
        prop:sessionKey={props.owner.sessionKey ?? ""}
        prop:sessionId={props.owner.sessionId ?? ""}
        prop:presented={presented() && menuOpen() && page() === "monitoring"}
        prop:inline={true}
        prop:menuPresentation={true}
        prop:controls={controls}
      />
    </div>
  );
  // Keep the same bridges connected across page changes and menu closure so late
  // write outcomes and retry state stay with their native owners.
  const ciPages: MenuEntry = {
    kind: "content",
    id: "ci-pages",
    content: (
      <>
        {checksContent}
        {monitoringContent}
      </>
    ),
  };
  const backItem = (): MenuEntry => ({
    id: "back",
    label: t("common.back"),
    closeOnSelect: false,
    render: (attributes) => (
      <button
        {...attributes}
        ref={(element) => {
          backButton = element;
        }}
        class="oc-menu-item chat-pr-menu__back"
        type="button"
      >
        <span class="oc-menu-item__icon">
          <Icon name="arrowLeft" />
        </span>
        <span class="oc-menu-item__label">{t("common.back")}</span>
        <span class="chat-pr-menu__value">#{props.pullRequest.number}</span>
      </button>
    ),
  });
  const items = createMemo<MenuEntry[]>(() =>
    page() !== "home"
      ? [
          backItem(),
          ciPages,
          ...(page() === "checks" && props.pullRequest.checksUrl
            ? [
                {
                  kind: "group" as const,
                  id: "checks-links",
                  class: "chat-pr-menu__group",
                  items: [
                    {
                      id: "checks-link",
                      label: t("chat.pullRequests.openChecks"),
                      icon: <Icon name="externalLink" />,
                      href: props.pullRequest.checksUrl,
                      attributes: {
                        target: "_blank",
                        rel: "noopener noreferrer",
                        "data-link-reader-preview": "off",
                      },
                    },
                  ],
                },
              ]
            : []),
        ]
      : [
          {
            kind: "content",
            id: "facts",
            content: (
              <div class="chat-pr-menu__facts">
                <div class="chat-pr-menu__repository">
                  <span>
                    {props.pullRequest.owner}/{props.pullRequest.repo}
                  </span>
                  <span>#{props.pullRequest.number}</span>
                </div>
                <Show
                  when={
                    props.pullRequest.additions !== undefined ||
                    props.pullRequest.deletions !== undefined
                  }
                >
                  <div class="chat-pr-menu__fact">
                    <Icon name="diff" />
                    <span>{t("chat.pullRequests.codeChanges")}</span>
                    <span class="chat-pr-menu__value">
                      <GitDiffValues
                        item={props.pullRequest}
                        classPrefix="chat-pr"
                        locale="en-US"
                      />
                    </span>
                  </div>
                </Show>
                <div class="chat-pr-menu__fact">
                  <Icon name={sessionPullRequestStateIcons[props.pullRequest.state]} />
                  <span>{t("chat.pullRequests.status")}</span>
                  <span class="chat-pr-menu__value">
                    {t(STATE_LABEL_KEYS[props.pullRequest.state])}
                  </span>
                </div>
                <Show
                  when={
                    props.pullRequest.state !== "merged" || props.owner.status === "unavailable"
                  }
                >
                  <StatusWarning status={props.owner.status} text />
                </Show>
              </div>
            ),
          },
          ciPages,
          {
            kind: "group",
            id: "checks-group",
            class: "chat-pr-menu__group",
            items: [
              {
                kind: "content",
                id: "checks-heading",
                content: (
                  <div class="chat-pr-menu__caption">{t("chat.pullRequests.checksTitle")}</div>
                ),
              },
              {
                id: "checks",
                label: `${t("chat.pullRequests.checksTitle")}: ${rollup()?.label ?? t("chat.pullRequests.automationNoChecks")}${rollup() ? ` ${rollup()?.count}` : ""}`,
                closeOnSelect: false,
                render: (attributes) => (
                  <button
                    {...attributes}
                    ref={(element) => {
                      checksButton = element;
                    }}
                    class="oc-menu-item chat-pr-menu__drill-trigger"
                    type="button"
                  >
                    <span class="oc-menu-item__icon chat-ci__status" data-state={rollup()?.state}>
                      <Icon name={rollup()?.icon ?? "listChecks"} />
                    </span>
                    <span class="oc-menu-item__label">
                      {rollup()?.label ?? t("chat.pullRequests.automationNoChecks")}
                    </span>
                    <span class="chat-pr-menu__value">{rollup()?.count}</span>
                    <Icon name="chevronRight" />
                  </button>
                ),
              },
            ],
          },
          {
            kind: "group",
            id: "links",
            class: "chat-pr-menu__group",
            items: [
              {
                id: "github",
                label: t("chat.pullRequests.openGitHub"),
                icon: <Icon name="externalLink" />,
                href: props.pullRequest.url,
                attributes: {
                  target: "_blank",
                  rel: "noopener noreferrer",
                  "data-link-reader-preview": "off",
                },
              },
              {
                id: "copy",
                label: t("chat.pullRequests.copyLink"),
                icon: <Icon name="link" />,
                disabled: copying(),
                closeOnSelect: false,
              },
              {
                kind: "content",
                id: "copy-error",
                content: (
                  <Show when={copyFailed()}>
                    <p class="chat-pr-menu__error" role="alert">
                      {t("chat.pullRequests.copyFailed")}
                    </p>
                  </Show>
                ),
              },
            ],
          },
          {
            id: "monitoring",
            label: t("chat.pullRequests.ciMonitoring"),
            closeOnSelect: false,
            render: (attributes) => (
              <button
                {...attributes}
                ref={(element) => {
                  monitoringButton = element;
                }}
                class="oc-menu-item chat-pr-menu__drill-trigger"
                type="button"
              >
                <span class="oc-menu-item__icon">
                  <Icon name="listChecks" />
                </span>
                <span class="oc-menu-item__label">{t("chat.pullRequests.ciMonitoring")}</span>
                <Icon name="chevronRight" />
              </button>
            ),
          },
          {
            kind: "group",
            id: "hide-group",
            class: "chat-pr-menu__group",
            items: [
              {
                id: "dismiss",
                label: t("chat.pullRequests.hide"),
                icon: <Icon name="eyeOff" />,
                disabled: props.disabled,
                variant: "danger",
              },
            ],
          },
        ],
  );
  return (
    <Menu
      controls={controls}
      id={"chat-pr-actions-" + id}
      class="chat-pr__actions"
      label={props.label}
      triggerClass="chat-pr__actions-trigger"
      trigger={<Icon name="moreHorizontal" />}
      placement="bottom-end"
      panelClass="chat-pr-menu chat-pr-menu--drill"
      open={presented() ? undefined : false}
      items={items()}
      ref={(handle) => {
        menu = handle;
      }}
      onBeforeShow={(event) => {
        if (!presented()) {
          event.preventDefault();
        }
      }}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (!open) {
          setCopyFailed(false);
          setPage("home");
        }
      }}
      onEscape={() => {
        if (page() === "home") {
          return false;
        }
        back();
        return true;
      }}
      onSelect={(item) => {
        if (item.id === "back") {
          back();
        }
        if (item.id === "checks" || item.id === "monitoring") {
          navigate(item.id);
        }
        if (item.id === "dismiss") {
          props.onDismiss();
        }
        if (item.id === "copy") {
          void copy();
        }
      }}
    />
  );
}
