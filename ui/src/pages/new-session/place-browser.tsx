import { createMemo, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import type { PlaceBrowserOptions } from "./place-browser.ts";
export function PlaceBrowser(props: { params: PlaceBrowserOptions }) {
  const view = createMemo(() => ({
    ...props.params.browser.view(),
    highlighted: props.params.browser.highlightedEntry(),
    usablePath: props.params.browser.usablePath(),
  }));
  return (
    <div
      class="new-session-page__browser"
      ref={nativeListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        props.params.onBack();
      })}
    >
      <div class="new-session-page__browser-head">
        <button
          type="button"
          class="new-session-page__browser-nav"
          title={t("newSession.browserUp")}
          aria-label={t("newSession.browserUp")}
          ref={nativeListener("click", () => {
            if (props.params.browser.listing?.parent) {
              void props.params.browser.navigate(props.params.browser.listing.parent);
            } else {
              props.params.onBack();
            }
          })}
        >
          <Icon name="arrowLeft" />
        </button>
        <input
          class="new-session-page__browser-path"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${props.params.id}-list`}
          aria-activedescendant={
            view().highlighted
              ? `${props.params.id}-option-${props.params.browser.activeIndex}`
              : undefined
          }
          aria-label={t("newSession.folder")}
          placeholder={props.params.label}
          value={props.params.browser.draft}
          onInput={(event: Event) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              props.params.browser.setDraft(event.currentTarget.value);
            }
          }}
          ref={nativeListener("keydown", (event: KeyboardEvent) => {
            switch (event.key) {
              case "ArrowDown":
              case "ArrowUp":
                event.preventDefault();
                props.params.browser.moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                requestAnimationFrame(() =>
                  document
                    .getElementById(`${props.params.id}-option-${props.params.browser.activeIndex}`)
                    ?.scrollIntoView({ block: "nearest" }),
                );
                break;
              case "Enter":
                event.preventDefault();
                void props.params.browser.activate();
                break;
              case "Tab":
                if (!event.shiftKey && props.params.browser.completeHighlighted()) {
                  event.preventDefault();
                }
                break;
            }
          })}
        />
        {props.params.browser.loading ? (
          <span class="new-session-page__browser-loading" role="status">
            {t("common.loading")}
          </span>
        ) : undefined}
        <button
          type="button"
          class="new-session-page__browser-nav"
          title={t("common.close")}
          aria-label={t("common.close")}
          ref={nativeListener("click", () => props.params.onClose())}
        >
          <Icon name="x" />
        </button>
      </div>
      {props.params.browser.error ? (
        <div class="new-session-page__error" role="alert">
          {props.params.browser.error}
        </div>
      ) : undefined}
      <div
        class="new-session-page__browser-list"
        role="listbox"
        id={`${props.params.id}-list`}
        aria-label={t("newSession.folder")}
      >
        {view().empty !== "none" ? (
          <div class="new-session-page__browser-empty">
            {t(
              view().empty === "no-matches"
                ? "newSession.browserNoMatches"
                : "newSession.browserEmpty",
            )}
          </div>
        ) : undefined}
        {
          <For each={view().entries} keyed={(entry) => entry.path}>
            {(entry, index) => (
              <button
                type="button"
                role="option"
                id={`${props.params.id}-option-${index()}`}
                aria-selected={index() === props.params.browser.activeIndex ? "true" : "false"}
                class={[
                  "new-session-page__browser-entry",
                  {
                    "new-session-page__browser-entry--active":
                      index() === props.params.browser.activeIndex,
                    "new-session-page__browser-entry--hidden": entry().hidden,
                  },
                ]}
                title={entry().hidden ? t("newSession.hiddenFolder") : undefined}
                ref={nativeListener(
                  "click",
                  () => void props.params.browser.navigate(entry().path),
                )}
              >
                <span class="new-session-page__target-icon" aria-hidden="true">
                  <Icon name="folder" />
                </span>
                <span>{entry().name}</span>
              </button>
            )}
          </For>
        }
      </div>
      <div class="new-session-page__browser-actions">
        {props.params.registerProjectPath ? (
          <button
            type="button"
            class="new-session-page__browser-register"
            disabled={props.params.registeringProject}
            ref={nativeListener("click", () => {
              const path = props.params.registerProjectPath;
              if (path) {
                props.params.onRegisterProject(path);
              }
            })}
          >
            {t("newSession.registerProject")}
          </button>
        ) : undefined}
        <button
          type="button"
          class="new-session-page__browser-use"
          disabled={view().usablePath === null || props.params.registeringProject}
          ref={nativeListener("click", () => {
            const path = props.params.browser.usablePath();
            if (path !== null) {
              props.params.onApplyFolder(path);
              props.params.onClose();
            }
          })}
        >
          {t("newSession.browserUse")}
        </button>
      </div>
    </div>
  );
}
