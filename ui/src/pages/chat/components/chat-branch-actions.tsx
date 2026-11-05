import { createMemo, createUniqueId, Show, useContext } from "solid-js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  personalGitHubPublicationSelection,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-owner.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { createGitHubPublicationAccountMenuItems } from "./chat-github-publication-menu.tsx";
import {
  githubPublicationAccountChoices,
  githubPublicationState,
  GitHubPublicationAction,
  GitHubPublicationDetails,
} from "./chat-github-publication.tsx";
import { StatusWarning } from "./chat-pull-request-shared.tsx";
import "./chat-pull-request-presenters.css";

export function ChatBranchActions(props: {
  branch?: ControlUiSessionBranch;
  branchName: string;
  status: ControlUiSessionPullRequestSnapshot["status"];
  publication?: GitHubPublicationView;
  presented: boolean;
  onDismiss?: (branch: ControlUiSessionBranch) => void;
}) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const dismissRef = controls.ref();
  let menu: MenuHandle | undefined;
  const parentPresented = useContext(ContentPresentation);
  const ownPresented = createMemo(() => props.presented);
  const presented = () => parentPresented() && ownPresented();

  const menuPublication = createMemo(() => {
    const publication = props.publication;
    return Boolean(
      publication &&
      publication.result?.status !== "published" &&
      (publication.result ||
        publication.locked ||
        (publication.onPublish &&
          !publication.selection &&
          !publication.options?.shared &&
          personalGitHubPublicationSelection(publication.options))),
    );
  });

  const publicationState = createMemo(() =>
    props.publication ? githubPublicationState(props.publication) : undefined,
  );
  const creating = () => publicationState() === "requested" || publicationState() === "publishing";
  const warning = () =>
    publicationState() === "failed" ||
    publicationState() === "unavailable" ||
    publicationState() === "unknown";

  const accountChoices = createMemo(() =>
    props.publication ? githubPublicationAccountChoices(props.publication) : undefined,
  );
  const accountItems = createGitHubPublicationAccountMenuItems({
    get choices() {
      return (accountChoices()?.accounts ?? []).toSorted((a, b) =>
        a.source === b.source ? 0 : a.source === "personal" ? -1 : 1,
      );
    },
    get selected() {
      return props.publication?.selection?.source;
    },
    get duplicateLogin() {
      return accountChoices()?.duplicateLogin ?? false;
    },
    get busy() {
      return props.publication?.activity != null;
    },
    trailingCheck: false,
    accountLabels: true,
  });
  const accountCaption: MenuEntry = {
    kind: "content",
    id: "publication-account-label",
    content: <div class="chat-pr-menu__caption">{t("githubPublication.publishAsLabel")}</div>,
  };

  // Account selection must not remount an open recovery disclosure.
  const publicationContent = (
    <>
      <Show when={props.publication}>
        {(publication) => (
          <div class="chat-pr-branch-menu__publication">
            <Show when={menuPublication()}>
              <GitHubPublicationAction
                publication={publication()}
                presented={presented()}
                accountSelector={false}
                menuControls
                controls={controls}
              />
            </Show>
            <GitHubPublicationDetails
              publication={publication()}
              menuControls
              controls={controls}
            />
          </div>
        )}
      </Show>
      <StatusWarning status={props.status} />
      <Show when={props.branch && props.onDismiss}>
        <div class="chat-pr-menu__group">
          <button
            ref={dismissRef}
            class="oc-menu-item"
            type="button"
            disabled={props.publication?.activity != null}
            aria-label={t("chat.pullRequests.dismissBranch", {
              branch: props.branchName,
            })}
            onClick={() => {
              menu?.close();
              if (props.branch) {
                props.onDismiss?.(props.branch);
              }
            }}
          >
            <span class="oc-menu-item__icon">
              <Icon name="eyeOff" />
            </span>
            {t("chat.pullRequests.hide")}
          </button>
        </div>
      </Show>
    </>
  );

  return (
    <div class="chat-pr__publication-actions">
      <Show
        when={props.publication}
        fallback={
          <Show when={props.branch?.createUrl}>
            {(url) => (
              <a class="chat-pr__create" href={url()} target="_blank" rel="noopener noreferrer">
                {t("chat.pullRequests.createPr")}
              </a>
            )}
          </Show>
        }
      >
        {(publication) => (
          <Show
            when={menuPublication()}
            fallback={
              <GitHubPublicationAction
                publication={publication()}
                presented={presented()}
                accountSelector={false}
                publishLabel={t("chat.pullRequests.createPr")}
                pendingLabel={t("chat.pullRequests.creating")}
              />
            }
          >
            <button
              class="chat-pr__create"
              type="button"
              aria-haspopup="menu"
              aria-controls={"chat-pr-branch-actions-" + id + ":content"}
              onClick={() => {
                menu?.open();
                menu?.focusFirst();
              }}
            >
              <Show when={creating() || publication().activity !== null}>
                <span class="btn__spinner" aria-hidden="true" />
              </Show>
              <Show when={publication().activity === null && warning()}>
                <Icon name="alertTriangle" class="chat-pr__publication-warning" />
              </Show>
              {creating()
                ? t("chat.pullRequests.creating")
                : publication().activity !== null
                  ? t(
                      publication().activity === "read"
                        ? "common.loading"
                        : "chat.pullRequests.creating",
                    )
                  : publicationState() === "unknown"
                    ? t("githubPublication.check")
                    : warning()
                      ? t("common.retry")
                      : publication().result
                        ? t("chat.sidePanel.review")
                        : t("chat.pullRequests.createPr")}
            </button>
          </Show>
        )}
      </Show>
      <Show
        when={
          accountChoices() ||
          menuPublication() ||
          props.publication?.error ||
          (props.branch && props.onDismiss)
        }
      >
        <Menu
          controls={controls}
          id={"chat-pr-branch-actions-" + id}
          class="chat-pr__actions"
          label={t("chat.pullRequests.actions", { reference: props.branchName })}
          triggerClass="chat-pr__actions-trigger"
          trigger={<Icon name="moreHorizontal" />}
          placement="bottom-end"
          panelClass="chat-pr-menu chat-pr-branch-menu"
          open={presented() ? undefined : false}
          onSelect={(item) => {
            if (item.id === "shared" || item.id === "personal") {
              props.publication?.onSelect?.(item.id);
            }
          }}
          onBeforeShow={(event) => {
            if (!presented()) {
              event.preventDefault();
            }
          }}
          ref={(handle) => {
            menu = handle;
          }}
          items={[
            ...(accountItems().length ? [accountCaption, ...accountItems()] : []),
            {
              kind: "content",
              id: "publication-actions",
              content: publicationContent,
            },
          ]}
        />
      </Show>
    </div>
  );
}
