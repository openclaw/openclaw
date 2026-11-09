import type { JSX } from "@solidjs/web";
import { createMemo, Show, type Accessor } from "solid-js";
import type { PickerOption, PickerParams } from "./select-picker-types.ts";
import { Icon } from "./solid/icon.tsx";

function Leading<Option extends PickerOption>(props: {
  option?: Option;
  params: PickerParams<Option>;
}) {
  const content = createMemo(() => props.option && props.params.renderLeading?.(props.option));
  return (
    <Show when={content() !== undefined && content() !== null}>
      <span class="picker-select__leading">{content()}</span>
    </Show>
  );
}

export function PickerOptionContent<Option extends PickerOption>(props: {
  attributes: Accessor<JSX.HTMLAttributes<HTMLDivElement>>;
  row: { option: Accessor<Option>; grouped: boolean };
  params: PickerParams<Option>;
}) {
  return (
    <div {...props.attributes()}>
      {!props.row.grouped && <Leading option={props.row.option()} params={props.params} />}
      <span class="picker-select__copy">
        <span class="picker-select__label" style={props.row.option().labelStyle}>
          {props.row.option().label}
        </span>
        <Show when={props.row.option().description}>
          <span class="picker-select__description">{props.row.option().description}</span>
        </Show>
      </span>
      <span class="picker-select__check" aria-hidden="true">
        <Show when={props.row.option().value === props.params.value}>
          <Icon name="check" />
        </Show>
      </span>
    </div>
  );
}

export function PickerTriggerContent<Option extends PickerOption>(props: {
  attributes: Accessor<JSX.ButtonHTMLAttributes<HTMLButtonElement>>;
  selected: Accessor<Option | undefined>;
  params: PickerParams<Option>;
}) {
  return (
    <button {...props.attributes()}>
      <Show when={props.params.variant === "submenu"}>
        <span class="picker-select__name">{props.params.label}</span>
      </Show>
      <Leading option={props.selected()} params={props.params} />
      <span class="picker-select__copy">
        <span class="picker-select__label">{props.selected()?.label ?? props.params.label}</span>
        <Show when={props.params.showSelectedDescription && props.selected()?.description}>
          <span class="picker-select__description">{props.selected()?.description}</span>
        </Show>
      </span>
      <span class="picker-select__chevron" aria-hidden="true">
        <Icon
          name={
            props.params.variant === "submenu" || props.params.sheet
              ? "chevronRight"
              : (props.params.triggerIcon ?? "chevronDown")
          }
        />
      </span>
    </button>
  );
}
