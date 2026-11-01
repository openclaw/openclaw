import { createMemo, createSignal, createUniqueId, Show, useContext } from "solid-js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import { GitDiffValues } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
  type MenuItemBindings,
} from "../../../components/solid/menu.tsx";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { sessionPullRequestStateIcons } from "../../../lib/session-pull-request-presentation.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { showToast } from "../../../lib/toast.ts";
import { ChatCiAutomationPanel, ChatCiDetailsPanel } from "./chat-ci-panels.tsx";
import { createPullRequestCopy } from "./chat-pull-request-copy.ts";
import {
  ChecksRows,
  PullRequestCopyError,
  StatusWarning,
  STATE_LABEL_KEYS,
  type ChatPullRequestsProps,
} from "./chat-pull-request-shared.tsx";

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
  url: string;
  pullRequest?: ControlUiSessionPullRequest;
  owner: ChatPullRequestsProps;
}) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const parentPresented = useContext(ContentPresentation);
  let menu: MenuHandle | undefined;
  const [page, setPage] = createSignal<"home" | "checks" | "monitoring">("home");
  const [visited, setVisited] = createSignal({ checks: false, monitoring: false });
  const navigate = (next: "checks" | "monitoring") => {
    setVisited((current) => ({ ...current, [next]: true }));
    setPage(next);
    queueMicrotask(() => menu?.itemElement("back")?.focus());
  };
  const back = () => {
    const previous = page() === "checks" ? "checks" : "monitoring";
    setPage("home");
    queueMicrotask(() => menu?.itemElement(previous)?.focus());
  };
  const [menuOpen, setMenuOpen] = createSignal(false);
  const presentation = createMemo(() => projectPresentation(props.presented));
  const presented = () => parentPresented() && !props.dismissed && presentation().read();
  const clipboard = createPullRequestCopy({
    url: () => props.url,
    presented: () => presented() && menu?.overlay.open === true,
    onCopied: () => {
      menu?.close();
      showToast({ message: t("chat.pullRequests.linkCopied") });
    },
  });
  const checks = () => props.pullRequest?.checks;
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
    <Show when={visited().checks ? props.pullRequest : undefined}>
      {(pullRequest) => (
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
          <ChatCiDetailsPanel
            pullRequest={pullRequest()}
            gateway={props.owner.gateway}
            sessionKey={props.owner.sessionKey ?? ""}
            presented={presented() && menuOpen() && page() === "checks"}
            inline
            menuControls
            controls={controls}
          />
        </div>
      )}
    </Show>
  );
  const monitoringContent = (
    <Show when={visited().monitoring ? props.pullRequest : undefined}>
      {(pullRequest) => (
        <div
          class="chat-pr-menu__page"
          hidden={page() !== "monitoring"}
          aria-label={t("chat.pullRequests.ciMonitoring")}
        >
          <div class="chat-pr-menu__caption">{t("chat.pullRequests.ciMonitoring")}</div>
          <ChatCiAutomationPanel
            pullRequest={pullRequest()}
            gateway={props.owner.gateway}
            sessionKey={props.owner.sessionKey ?? ""}
            sessionId={props.owner.sessionId ?? ""}
            presented={presented() && menuOpen() && page() === "monitoring"}
            inline
            menuPresentation
            controls={controls}
          />
        </div>
      )}
    </Show>
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
      <button {...attributes} class="oc-menu-item chat-pr-menu__back" type="button">
        <span class="oc-menu-item__icon">
          <Icon name="arrowLeft" />
        </span>
        <span class="oc-menu-item__label">{t("common.back")}</span>
        <span class="chat-pr-menu__value">#{props.pullRequest?.number}</span>
      </button>
    ),
  });
  const items = createMemo<MenuEntry[]>(() =>
    page() !== "home"
      ? [
          backItem(),
          ciPages,
          ...(page() === "checks" && props.pullRequest?.checksUrl
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
                      href: props.pullRequest?.checksUrl,
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
              <Show when={props.pullRequest}>
                {(pullRequest) => (
                  <div class="chat-pr-menu__facts">
                    <div class="chat-pr-menu__repository">
                      <span>
                        {pullRequest().owner}/{pullRequest().repo}
                      </span>
                      <span>#{pullRequest().number}</span>
                    </div>
                    <Show
                      when={
                        pullRequest().additions !== undefined ||
                        pullRequest().deletions !== undefined
                      }
                    >
                      <div class="chat-pr-menu__fact">
                        <Icon name="diff" />
                        <span>{t("chat.pullRequests.codeChanges")}</span>
                        <span class="chat-pr-menu__value">
                          <GitDiffValues
                            item={pullRequest()}
                            classPrefix="chat-pr"
                            locale="en-US"
                          />
                        </span>
                      </div>
                    </Show>
                    <div class="chat-pr-menu__fact">
                      <Icon name={sessionPullRequestStateIcons[pullRequest().state]} />
                      <span>{t("chat.pullRequests.status")}</span>
                      <span class="chat-pr-menu__value">
                        {t(STATE_LABEL_KEYS[pullRequest().state])}
                      </span>
                    </div>
                    <Show
                      when={
                        pullRequest().state !== "merged" || props.owner.status === "unavailable"
                      }
                    >
                      <StatusWarning status={props.owner.status} text />
                    </Show>
                  </div>
                )}
              </Show>
            ),
          },
          ciPages,
          ...(props.pullRequest
            ? [
                {
                  kind: "group" as const,
                  id: "checks-group",
                  class: "chat-pr-menu__group",
                  items: [
                    {
                      kind: "content" as const,
                      id: "checks-heading",
                      content: (
                        <div class="chat-pr-menu__caption">
                          {t("chat.pullRequests.checksTitle")}
                        </div>
                      ),
                    },
                    {
                      id: "checks",
                      label: `${t("chat.pullRequests.checksTitle")}: ${rollup()?.label ?? t("chat.pullRequests.automationNoChecks")}${rollup() ? ` ${rollup()?.count}` : ""}`,
                      closeOnSelect: false,
                      render: (attributes: MenuItemBindings) => (
                        <button
                          {...attributes}
                          class="oc-menu-item chat-pr-menu__drill-trigger"
                          type="button"
                        >
                          <span
                            class="oc-menu-item__icon chat-ci__status"
                            data-state={rollup()?.state}
                          >
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
              ]
            : []),
          {
            kind: "group",
            id: "links",
            class: "chat-pr-menu__group",
            items: [
              {
                id: "github",
                label: t("chat.pullRequests.openGitHub"),
                icon: <Icon name="externalLink" />,
                href: props.url,
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
                disabled: clipboard.copying(),
                closeOnSelect: false,
              },
              {
                kind: "content",
                id: "copy-error",
                content: <PullRequestCopyError clipboard={clipboard} />,
              },
            ],
          },
          ...(props.pullRequest
            ? [
                {
                  id: "monitoring",
                  label: t("chat.pullRequests.ciMonitoring"),
                  closeOnSelect: false,
                  render: (attributes: MenuItemBindings) => (
                    <button
                      {...attributes}
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
              ]
            : []),
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
          clipboard.retire();
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
          void clipboard.copy();
        }
      }}
    />
  );
}
