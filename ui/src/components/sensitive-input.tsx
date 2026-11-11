import { createMemo } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const maskedValue = (value: string) =>
  "*".repeat(Array.from(graphemeSegmenter.segment(value)).length);

export function SensitiveInput(props: {
  id: string;
  value: string;
  revealed: boolean;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  label?: string;
  onInput: (value: string) => void;
  onToggle: () => void;
}) {
  let maskText: HTMLSpanElement | undefined;
  const value = createMemo(() => props.value);
  const visibilityLabel = () =>
    t(props.revealed ? "configForm.hideValue" : "configForm.revealValue");
  const syncMask = (input: HTMLInputElement) => {
    if (maskText) {
      maskText.textContent = props.revealed ? "" : maskedValue(input.value);
      maskText.style.transform = `translateX(${-input.scrollLeft}px)`;
    }
  };
  return (
    <span
      class="oc-sensitive-input"
      data-sensitive-input
      data-sensitive-mask-ready="true"
      data-revealed={String(props.revealed)}
    >
      <span
        class="oc-sensitive-mask"
        aria-hidden="true"
        data-sensitive-mask
        hidden={props.revealed}
      >
        <span
          ref={(element) => {
            maskText = element;
          }}
          data-sensitive-mask-text
        >
          {props.revealed ? "" : maskedValue(value())}
        </span>
      </span>
      <input
        id={props.id}
        class="input"
        name="wizard-text"
        type={props.revealed ? "text" : "password"}
        autocomplete="off"
        spellcheck="false"
        placeholder={props.placeholder ?? ""}
        value={value()}
        disabled={props.disabled}
        aria-invalid={props.invalid ? "true" : undefined}
        aria-describedby={props.describedBy}
        aria-label={props.label}
        data-sensitive-value
        onInput={(event) => {
          syncMask(event.currentTarget);
          props.onInput(event.currentTarget.value);
        }}
        onChange={(event) => syncMask(event.currentTarget)}
        onFocus={(event) => syncMask(event.currentTarget)}
        onScroll={(event) => syncMask(event.currentTarget)}
      />
      <openclaw-tooltip prop:content={visibilityLabel()}>
        <button
          type="button"
          class="oc-sensitive-toggle"
          aria-label={visibilityLabel()}
          aria-controls={props.id}
          aria-pressed={props.revealed ? "true" : "false"}
          data-sensitive-icon={props.revealed ? "eye-off" : "eye"}
          disabled={props.disabled}
          onClick={() => props.onToggle()}
        >
          <Icon name={props.revealed ? "eyeOff" : "eye"} />
        </button>
      </openclaw-tooltip>
    </span>
  );
}
