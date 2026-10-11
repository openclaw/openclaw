import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { For, createEffect, createMemo } from "solid-js";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { JSX } from "../../types/solid-elements.js";
import { renderProviderIcon } from "./model-setup-icon-loader.tsx";

type ManualProvider = SystemAgentSetupDetectResult["manualProviders"][number];

export function manualProviderActivation(
  providers: readonly ManualProvider[],
  providerId: string,
  apiKey: string,
): SystemAgentSetupActivateParams | null {
  const provider = providers.find((candidate) => candidate.id === providerId);
  const value = apiKey.trim();
  return provider && value
    ? {
        kind: "api-key",
        authChoice: provider.id,
        apiKey: value,
        ...(provider.modelTarget ? { modelTarget: provider.modelTarget } : {}),
      }
    : null;
}

export function revealManualProvider(root: ParentNode): void {
  const input = root.querySelector<HTMLInputElement>('.model-setup__manual input[type="password"]');
  root.querySelector("openclaw-modal-dialog")?.setReturnFocusTarget(input);
  input?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
}

type WebAwesomeSelectEvent = Parameters<
  NonNullable<JSX.IntrinsicElements["wa-dropdown"]["onWa-select"]>
>[0];

function restoreProviderTriggerAfterHide(dropdown: HTMLElement) {
  dropdown.addEventListener(
    "wa-after-hide",
    () => dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true }),
    { once: true },
  );
}

function handleManualProviderKeydown(event: KeyboardEvent, dropdown: WaDropdown): void {
  if (!dropdown.open || (event.key !== "Tab" && event.key !== "Escape")) {
    return;
  }
  event.preventDefault();
  if (event.key === "Tab") {
    event.stopPropagation();
    const focusTarget = event.shiftKey
      ? dropdown.querySelector<HTMLElement>('[slot="trigger"]')
      : dropdown
          .closest(".model-setup__manual")
          ?.querySelector<HTMLElement>('input[type="password"]');
    dropdown.addEventListener("wa-after-hide", () => focusTarget?.focus({ preventScroll: true }), {
      once: true,
    });
    dropdown.open = false;
  } else {
    // The settings-level Escape shortcut runs before Web Awesome's document
    // listener. Claim the event here and restore the durable trigger after hide.
    restoreProviderTriggerAfterHide(dropdown);
  }
}

function handleManualProviderSelect(
  event: WebAwesomeSelectEvent,
  currentProviderId: string,
  onChange: (providerId: string) => void,
): void {
  const item = event.detail.item;
  // SAFETY: this handler is installed on the wa-dropdown host, which owns currentTarget.
  const dropdown = event.currentTarget as WaDropdown;
  const value = item.value;
  if (!value) {
    return;
  }
  if (value !== currentProviderId) {
    restoreProviderTriggerAfterHide(dropdown);
    onChange(value);
    return;
  }
  event.preventDefault();
  item.checked = true;
  dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true });
  dropdown.open = false;
}

export function manualProviderName(provider: ManualProvider): string {
  return provider.groupLabel?.trim() || provider.label;
}

function manualProviderMethod(provider: ManualProvider): string | undefined {
  const method = provider.label.trim();
  return method === manualProviderName(provider) ? undefined : method;
}

type ManualProviderPickerProps = Parameters<typeof renderProviderIcon>[0] & {
  manualProviderId: string;
  actionsDisabled: boolean;
  onManualProviderChange: (providerId: string) => void;
};

export function ManualProviderPicker(
  props: ManualProviderPickerProps & {
    result: Pick<SystemAgentSetupDetectResult, "manualProviders">;
    provider: ManualProvider | undefined;
  },
) {
  const providerMethod = createMemo(() =>
    props.provider ? manualProviderMethod(props.provider) : undefined,
  );
  const triggerLabel = createMemo(() =>
    props.provider
      ? [manualProviderName(props.provider), providerMethod()].filter(Boolean).join(", ")
      : t("modelSetup.manual.selectProvider"),
  );
  const providers = createMemo(() =>
    props.result.manualProviders.toSorted((a, b) =>
      manualProviderName(a).localeCompare(manualProviderName(b)),
    ),
  );
  return (
    <wa-dropdown
      class="model-setup-provider-select"
      placement="bottom-start"
      aria-label={t("modelSetup.manual.provider")}
      onWa-select={(event) =>
        handleManualProviderSelect(event, props.manualProviderId, props.onManualProviderChange)
      }
      onKeyDown={(event) => handleManualProviderKeydown(event, event.currentTarget)}
    >
      <button
        slot="trigger"
        type="button"
        class="model-setup-provider-select__trigger"
        aria-label={`${t("modelSetup.manual.provider")}: ${triggerLabel()}`}
        disabled={props.actionsDisabled || providers().length === 0}
      >
        {props.provider ? (
          renderProviderIcon(props, props.provider, "model-setup__icon--picker")
        ) : (
          <span class="model-setup-provider-select__placeholder-icon" aria-hidden="true">
            <Icon name="key" />
          </span>
        )}
        <span class="model-setup-provider-select__copy">
          <strong>
            {props.provider
              ? manualProviderName(props.provider)
              : t("modelSetup.manual.selectProvider")}
          </strong>
          {props.provider ? (
            providerMethod() ? (
              <span>{providerMethod()}</span>
            ) : undefined
          ) : (
            <span>{t("modelSetup.manual.selectProviderHint")}</span>
          )}
        </span>
        <span class="model-setup-provider-select__chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
      <For each={providers()}>
        {(entry) => {
          const selected = () => entry.id === props.manualProviderId;
          let item: HTMLElement | undefined;
          createEffect(selected, (checked) => syncDropdownItemRadio(item, checked));
          const entryMethod = manualProviderMethod(entry);
          const accessibleLabel = [manualProviderName(entry), entryMethod, entry.hint]
            .filter(Boolean)
            .join(", ");
          return (
            <wa-dropdown-item
              class="model-setup-provider-select__option"
              data-manual-provider={entry.id}
              data-selected={selected() ? "" : undefined}
              aria-label={accessibleLabel}
              prop:value={entry.id}
              prop:type="checkbox"
              prop:checked={selected()}
              prop:disabled={props.actionsDisabled}
              autofocus={selected() && !props.actionsDisabled}
              ref={(element) => {
                item = element;
              }}
            >
              <span slot="icon">
                {renderProviderIcon(props, entry, "model-setup__icon--picker")}
              </span>
              <span class="model-setup-provider-select__copy">
                <strong>{manualProviderName(entry)}</strong>
                {entryMethod ? <span>{entryMethod}</span> : undefined}
                {entry.hint ? <small>{entry.hint}</small> : undefined}
              </span>
            </wa-dropdown-item>
          );
        }}
      </For>
    </wa-dropdown>
  );
}
