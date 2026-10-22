import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { createPendingFocus } from "../lib/reactive/pending-focus.ts";
import "../styles/option-card.css";

type OptionCardOption = {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

type OptionCardProps = {
  header?: string;
  question: string;
  options: readonly OptionCardOption[];
  disabled?: boolean;
  onSelect?: (value: string) => void;
  onSkip?: () => void;
};

const ARROW_STEPS: Partial<Record<string, number>> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

export function OptionCard(input: { props: OptionCardProps }) {
  let host!: HTMLElement;
  const options = createMemo(() => input.props.options.slice(0, 4));
  const recommendedIndex = createMemo(() => options().findIndex((option) => option.recommended));
  const request = createMemo(
    () => ({
      key: JSON.stringify([
        input.props.header ?? "",
        input.props.question,
        input.props.options.map((option) => [
          option.value,
          option.label,
          option.recommended === true,
        ]),
      ]),
      recommended: options().find((option) => option.recommended)?.value ?? "",
    }),
    { equals: (previous, next) => previous.key === next.key },
  );
  // A new request resets the local selection; display-only option refreshes preserve it.
  const [selected, setSelected] = createSignal(() => request().recommended);
  // Roving tabindex: the checked choice, else the first, is the group's only Tab stop.
  const tabbableIndex = createMemo(() =>
    Math.max(
      0,
      options().findIndex((option) => option.value === selected()),
    ),
  );
  const choices = new Set<HTMLButtonElement>();
  createPendingFocus(
    () => ({ request: request(), disabled: input.props.disabled, selected: selected() }),
    {
      requested: (current, previous) =>
        current.request.key !== previous?.request.key
          ? Boolean(current.request.recommended)
          : undefined,
      ready: (current) => !current.disabled,
      focus: (current) => {
        const active = host.ownerDocument.activeElement;
        if (active && active !== host.ownerDocument.body && !host.contains(active)) {
          return;
        }
        [...choices]
          .find((button) => button.dataset.optionValue === current.selected)
          ?.focus({ preventScroll: true });
      },
    },
  );
  const select = (value: string) => {
    if (input.props.disabled) {
      return;
    }
    setSelected(value);
    input.props.onSelect?.(value);
  };
  // Arrow keys move the checked choice without answering; Space and Enter still answer.
  const onChoicesKeyDown = (event: KeyboardEvent) => {
    const values = options().map((option) => option.value);
    const target = [...choices].find((button) => button === event.target);
    const current = target ? values.indexOf(target.dataset.optionValue ?? "") : -1;
    const step = ARROW_STEPS[event.key];
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? values.length - 1
          : step === undefined
            ? -1
            : (current + step + values.length) % values.length;
    if (input.props.disabled || current < 0 || next < 0) {
      return;
    }
    event.preventDefault();
    setSelected(values[next]!);
    [...choices].find((button) => button.dataset.optionValue === values[next])?.focus();
  };
  return (
    <openclaw-option-card ref={(element) => (host = element)}>
      <section class="option-card" role="group" aria-label={input.props.question}>
        <Show when={input.props.header}>
          <div class="option-card__chip">{input.props.header}</div>
        </Show>
        <div class="option-card__question">{input.props.question}</div>
        <div class="option-card__choices" role="radiogroup" onKeyDown={onChoicesKeyDown}>
          <For each={options()} keyed={(option) => option.value}>
            {(option, index) => {
              let button: HTMLButtonElement;
              onCleanup(() => choices.delete(button));
              return (
                <button
                  ref={(element) => choices.add((button = element))}
                  class={[
                    "option-card__choice",
                    {
                      "option-card__choice--recommended": index() === recommendedIndex(),
                      "option-card__choice--selected": option().value === selected(),
                    },
                  ]}
                  type="button"
                  role="radio"
                  aria-checked={option().value === selected() ? "true" : "false"}
                  tabindex={index() === tabbableIndex() ? 0 : -1}
                  data-option-value={option().value}
                  disabled={input.props.disabled}
                  onClick={() => select(option().value)}
                >
                  <span class="option-card__choice-copy">
                    <strong>{option().label}</strong>
                    <Show when={option().description}>
                      <span class="option-card__description">{option().description}</span>
                    </Show>
                  </span>
                  <Show when={index() === recommendedIndex()}>
                    <span class="option-card__recommended">{t("optionCard.recommended")}</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        <button
          class="option-card__skip"
          type="button"
          disabled={input.props.disabled}
          onClick={() => !input.props.disabled && input.props.onSkip?.()}
        >
          {t("optionCard.skip")}
        </button>
      </section>
    </openclaw-option-card>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-option-card": HTMLAttributes<HTMLElement>;
    }
  }
}
