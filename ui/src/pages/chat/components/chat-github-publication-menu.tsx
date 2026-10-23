import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuControls, type MenuItem } from "../../../components/solid/menu.tsx";
import { resolveAvatarInitials } from "../../../lib/identity-avatar.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";

/** GitHub supplies a login here, not a Gateway profile or a remote avatar URL. */
export function GitHubPublicationAvatar(props: { login: string }) {
  return (
    <span class="github-publication-mobile__avatar" aria-hidden="true">
      {resolveAvatarInitials({ username: props.login }).initials}
    </span>
  );
}

type GitHubPublicationMenuProps = {
  choices: readonly { source: "shared" | "personal"; login: string; label: string }[];
  selected?: "shared" | "personal";
  duplicateLogin: boolean;
  busy: boolean;
  presented: PresentationValue;
  mobile?: boolean;
  menuControls?: boolean;
  controls?: MenuControls;
  trigger?: JSX.Element;
  onSelect: (source: "shared" | "personal") => void;
};

export function createGitHubPublicationAccountMenuItems(
  props: Pick<
    GitHubPublicationMenuProps,
    "choices" | "selected" | "duplicateLogin" | "busy" | "mobile"
  > & { trailingCheck?: boolean; accountLabels?: boolean },
) {
  return createMemo<MenuItem[]>(() =>
    props.choices.map((choice) => ({
      id: choice.source,
      label: `@${choice.login}${props.mobile || props.duplicateLogin ? ` · ${choice.label}` : ""}`,
      class: "session-menu__item",
      type: "radio" as const,
      checked: props.selected === choice.source,
      disabled: props.busy,
      content: props.mobile ? (
        <span class="github-publication-mobile__choice">
          <GitHubPublicationAvatar login={choice.login} />
          <span class="github-publication-mobile__choice-text">
            <span>{choice.label}</span>
            <span class="github-publication-mobile__choice-login">@{choice.login}</span>
          </span>
        </span>
      ) : props.accountLabels ? (
        <span class="chat-pr-account-choice">
          <span>{choice.label}</span>
          <span class="chat-pr-account-choice__login">@{choice.login}</span>
        </span>
      ) : (
        <span class="session-menu__text">
          @{choice.login}
          {props.duplicateLogin ? ` · ${choice.label}` : undefined}
        </span>
      ),
      details:
        props.trailingCheck === false ? undefined : (
          <span class="session-menu__icon" aria-hidden="true">
            {props.selected === choice.source && <Icon name="check" />}
          </span>
        ),
    })),
  );
}

export function GitHubPublicationMenu(props: GitHubPublicationMenuProps) {
  const id = createUniqueId();
  const triggerRef = props.controls?.ref();
  const presentation = createMemo(() => projectPresentation(props.presented));
  const selectedChoice = () => props.choices.find((choice) => choice.source === props.selected);
  const label = () => {
    const selected = props.mobile ? selectedChoice() : undefined;
    return selected
      ? `${t("githubPublication.account")}: ${selected.label}, @${selected.login}`
      : t("githubPublication.account");
  };
  const items = createGitHubPublicationAccountMenuItems(props);
  return (
    <Menu
      ref={(handle) => {
        if (handle.overlay.trigger) {
          triggerRef?.(handle.overlay.trigger);
        }
      }}
      id={`github-publication-${id}`}
      class={props.mobile ? "github-publication-mobile__accounts" : "chat-pr__accounts"}
      panelClass={
        props.mobile ? "github-publication-mobile__accounts-panel" : "chat-pr__accounts-panel"
      }
      placement="top-end"
      label={label()}
      disabled={props.busy}
      triggerAttributes={{ "data-form-control": props.menuControls ? "" : undefined }}
      triggerClass={
        props.mobile
          ? "github-publication-mobile__account-trigger"
          : "btn btn--ghost btn--icon chat-icon-btn"
      }
      trigger={
        <Show when={props.trigger} fallback={<Icon name="chevronDown" />}>
          {props.trigger}
        </Show>
      }
      items={items()}
      open={presentation().read() ? undefined : false}
      onBeforeShow={(event) => {
        if (!presentation().read()) {
          event.preventDefault();
        }
      }}
      onSelect={(item) => {
        if (item.id === "shared" || item.id === "personal") {
          props.onSelect(item.id);
        }
      }}
    />
  );
}
