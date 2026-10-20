import { createMemo, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";

export function GitHubPublicationMenu(props: {
  choices: readonly { source: "shared" | "personal"; login: string; label: string }[];
  selected?: "shared" | "personal";
  duplicateLogin: boolean;
  busy: boolean;
  presented: PresentationValue;
  onSelect: (source: "shared" | "personal") => void;
}) {
  const id = createUniqueId();
  const presentation = createMemo(() => projectPresentation(props.presented));
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
