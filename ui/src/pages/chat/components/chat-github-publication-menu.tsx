import { createEffect, createMemo, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuHandle } from "../../../components/solid/menu.tsx";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function GitHubPublicationMenu(props: {
  choices: readonly { source: "shared" | "personal"; login: string; label: string }[];
  selected?: "shared" | "personal";
  duplicateLogin: boolean;
  busy: boolean;
  presented: PresentationValue;
  onSelect: (source: "shared" | "personal") => void;
}) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  const isPresented = (value: PresentationValue) =>
    typeof value === "boolean" ? value : value.isPresented();
  createEffect(
    () => props.presented,
    (value) => {
      const sync = () => {
        if (!isPresented(value)) {
          menu?.close();
        }
      };
      sync();
      if (typeof value !== "boolean") {
        value.owner.addEventListener(PRESENTATION_CHANGED_EVENT, sync);
        return () => value.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, sync);
      }
      return undefined;
    },
  );
  const items = createMemo(() =>
    props.choices.map((choice) => ({
      id: choice.source,
      label: `@${choice.login}${props.duplicateLogin ? ` · ${choice.label}` : ""}`,
      class: "session-menu__item",
      type: "radio" as const,
      checked: props.selected === choice.source,
      disabled: props.busy,
      content: (
        <span class="session-menu__text">
          @{choice.login}
          {props.duplicateLogin ? ` · ${choice.label}` : undefined}
        </span>
      ),
      details: (
        <span class="session-menu__icon" aria-hidden="true">
          {props.selected === choice.source && <Icon name="check" />}
        </span>
      ),
    })),
  );
  return (
    <Menu
      id={`github-publication-${id}`}
      class="chat-pr__accounts"
      panelClass="chat-pr__accounts-panel"
      placement="top-end"
      label={t("githubPublication.account")}
      disabled={props.busy}
      triggerClass="btn btn--ghost btn--icon chat-icon-btn"
      trigger={<Icon name="chevronDown" />}
      items={items()}
      ref={(handle) => {
        menu = handle;
      }}
      onBeforeShow={(event) => {
        if (!isPresented(props.presented)) {
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
