import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { SecretRefSource } from "../../../../src/secrets/ref-contract.ts";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { CredentialProviders } from "./credential-providers.ts";

export function CredentialProviderPicker(props: {
  source: SecretRefSource;
  value: string;
  providers: CredentialProviders;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  let input: HTMLInputElement | undefined;
  const source = createMemo(() => props.source);
  // A source change closes custom entry without replacing the operator's provider value.
  const [custom, setCustom] = createSignal(() => {
    source();
    return false;
  });
  const catalog = () => props.providers[props.source];
  const customValue = createMemo(() => {
    let value = "__custom_provider__";
    while (value === props.value || catalog().aliases.includes(value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => [
    ...catalog().aliases.map((value) => ({
      value,
      label: value,
      description:
        value === catalog().defaultAlias ? t("pluginsPage.credentials.defaultProvider") : undefined,
    })),
    ...(props.value && !catalog().aliases.includes(props.value)
      ? [{ value: props.value, label: props.value }]
      : []),
    { value: customValue(), label: t("pluginsPage.credentials.enterProvider") },
  ]);
  return (
    <label>
      {t("pluginsPage.credentials.provider")}
      <Picker
        label={t("pluginsPage.credentials.provider")}
        value={custom() ? customValue() : props.value}
        options={options()}
        searchable="always"
        disabled={props.disabled}
        onChange={(value) => {
          if (value === customValue()) {
            setCustom(true);
            onSettled(() => {
              input?.focus();
              input?.select();
            });
          } else {
            setCustom(false);
            props.onChange(value);
          }
        }}
      />
      <Show when={custom()}>
        <input
          ref={(element) => (input = element)}
          class="settings-input"
          aria-label={t("pluginsPage.credentials.customProvider")}
          value={props.value}
          disabled={props.disabled}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      </Show>
    </label>
  );
}
