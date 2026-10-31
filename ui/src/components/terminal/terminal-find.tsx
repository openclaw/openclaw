import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { registerTerminalEnglish } from "../../i18n/locales/en-terminal.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import {
  findTerminalMatches,
  revealTerminalMatch,
  type TerminalFindMatch,
} from "./terminal-find.ts";
import type { TerminalPanelSessionTab } from "./terminal-panel-session-types.ts";

registerEnglishCatalog(registerTerminalEnglish);

/** A tab-local search snapshot. Refresh/Next re-read the emulator after streamed output. */
export function TerminalFind(props: { tab: Pick<TerminalPanelSessionTab, "controller"> }) {
  const [open, setOpen] = createSignal(false);
  const [result, setResult] = createSignal<{
    query: string;
    matches: TerminalFindMatch[];
    index: number;
  }>({ query: "", matches: [], index: 0 });
  let input: HTMLInputElement | undefined;
  const selected = createMemo(() => result().matches[result().index]);
  function find(query: string, direction = 0) {
    const matches = findTerminalMatches(props.tab.controller.terminal, query);
    const index =
      direction && query === result().query && matches.length
        ? (result().index + direction + matches.length) % matches.length
        : 0;
    setResult({ query, matches, index });
    if (matches[index]) {
      revealTerminalMatch(props.tab.controller.terminal, matches[index]);
    }
  }
  function close() {
    setOpen(false);
    props.tab.controller.terminal.focus();
  }
  return (
    <div class={["tp-find", { "tp-find--open": open() }]}>
      <Show
        when={open()}
        fallback={
          <button
            class="tp-find__open"
            type="button"
            aria-label={t("terminal.find")}
            onClick={() => {
              setOpen(true);
              onSettled(() => input?.focus());
            }}
          >
            <Icon name="search" />
            {t("terminal.find")}
          </button>
        }
      >
        <div
          class="tp-find__controls"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
            if (event.key === "Enter" && event.target === input) {
              event.preventDefault();
              event.stopPropagation();
              find(result().query, event.shiftKey ? -1 : 1);
            }
          }}
        >
          <input
            ref={(element) => {
              input = element;
            }}
            type="search"
            aria-label={t("terminal.find")}
            aria-description={t("terminal.findScope")}
            placeholder={t("terminal.find")}
            value={result().query}
            autocomplete="off"
            spellcheck="false"
            onInput={(event) => find(event.currentTarget.value)}
          />
          <span class="tp-find__count" role="status" aria-live="polite">
            {result().query
              ? t("terminal.findCount", {
                  current: String(result().matches.length ? result().index + 1 : 0),
                  total: String(result().matches.length),
                })
              : ""}
          </span>
          <PanelIconButton
            class="tp-find__button"
            label={t("terminal.findPrevious")}
            icon={<Icon name="chevronUp" />}
            disabled={!result().matches.length}
            onClick={() => find(result().query, -1)}
          />
          <PanelIconButton
            class="tp-find__button"
            label={t("terminal.findNext")}
            icon={<Icon name="chevronDown" />}
            disabled={!result().matches.length}
            onClick={() => find(result().query, 1)}
          />
          <PanelIconButton
            class="tp-find__button"
            label={t("terminal.findRefresh")}
            icon={<Icon name="refresh" />}
            onClick={() => find(result().query)}
          />
          <PanelIconButton
            class="tp-find__button"
            label={t("terminal.findClose")}
            icon={<Icon name="x" />}
            onClick={close}
          />
        </div>
        <Show when={selected()}>
          {(match) => (
            <div class="tp-find__preview" title={match().line}>
              {match().line.slice(0, match().start)}
              <mark>
                {match().line.slice(match().start, match().start + result().query.length)}
              </mark>
              {match().line.slice(match().start + result().query.length)}
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
