import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
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
type BridgeProps = { props?: OptionCardProps };
type OptionCardElement = SolidBridgeElement<BridgeProps>;

function OptionCardContent(input: BridgeProps & { host: OptionCardElement }) {
  const options = () => input.props?.options.slice(0, 4) ?? [];
  const recommendedIndex = () => options().findIndex((option) => option.recommended);
  const requestKey = createMemo(() => {
    const props = input.props;
    return props
      ? JSON.stringify([
          props.header ?? "",
          props.question,
          props.options.map((option) => [option.value, option.label, option.recommended === true]),
        ])
      : "";
  });
  const [selected, setSelected] = createSignal(() => {
    requestKey();
    return untrack(() => options().find((option) => option.recommended)?.value ?? "");
  });
  let focusPreselection = false;
  createEffect(
    () => ({ key: requestKey(), disabled: input.props?.disabled }),
    (current, previous) => {
      if (current.key !== previous?.key) {
        focusPreselection = Boolean(selected());
      }
      if (!focusPreselection || current.disabled) {
        return;
      }
      focusPreselection = false;
      const active = input.host.ownerDocument.activeElement;
      if (active && active !== input.host.ownerDocument.body && !input.host.contains(active)) {
        return;
      }
      [...input.host.querySelectorAll<HTMLButtonElement>(".option-card__choice")]
        .find((button) => button.dataset.optionValue === selected())
        ?.focus({ preventScroll: true });
    },
  );
  const select = (value: string) => {
    if (input.props?.disabled) {
      return;
    }
    setSelected(value);
    input.props?.onSelect?.(value);
    input.host.dispatchEvent(
      new CustomEvent("option-select", {
        bubbles: true,
        composed: true,
        detail: { value },
      }),
    );
  };
  const skip = () => {
    if (input.props?.disabled) {
      return;
    }
    input.props?.onSkip?.();
    input.host.dispatchEvent(new CustomEvent("option-skip", { bubbles: true, composed: true }));
  };
  return (
    <Show when={input.props}>
      {(props) => (
        <section class="option-card" role="group" aria-label={props().question}>
          <Show when={props().header}>
            <div class="option-card__chip">{props().header}</div>
          </Show>
          <div class="option-card__question">{props().question}</div>
          <div class="option-card__choices" role="radiogroup">
            <For each={options()} keyed={(option) => option.value}>
              {(option, index) => (
                <button
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
                  data-option-value={option().value}
                  disabled={props().disabled}
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
              )}
            </For>
          </div>
          <button
            class="option-card__skip"
            type="button"
            disabled={props().disabled}
            onClick={skip}
          >
            {t("optionCard.skip")}
          </button>
        </section>
      )}
    </Show>
  );
}

defineSolidBridge<BridgeProps>(
  "openclaw-option-card",
  (props, host) => <OptionCardContent props={props.props} host={host} />,
  {
    properties: { props: { default: undefined, attribute: false } },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-option-card": OptionCardElement;
  }
}
