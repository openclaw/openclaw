import { createMemo, createUniqueId } from "solid-js";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuHandle } from "../../components/solid/menu.tsx";
import { t } from "../../lib/reactive/i18n.ts";
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
  nextTabTarget?: () => HTMLInputElement | undefined;
};

export function ManualProviderPicker(
  props: ManualProviderPickerProps & {
    result: Pick<SystemAgentSetupDetectResult, "manualProviders">;
    provider: ManualProvider | undefined;
  },
) {
  const id = createUniqueId();
  let menu: MenuHandle;
  const providerMethod = createMemo(() =>
    props.provider ? manualProviderMethod(props.provider) : undefined,
  );
  const triggerLabel = createMemo(() =>
    props.provider
      ? [manualProviderName(props.provider), providerMethod()].filter(Boolean).join(", ")
      : t("modelSetup.manual.selectProvider"),
  );
  const items = createMemo(() =>
    props.result.manualProviders
      .toSorted((a, b) => manualProviderName(a).localeCompare(manualProviderName(b)))
      .map((entry) => {
        const selected = entry.id === props.manualProviderId;
        const method = manualProviderMethod(entry);
        return {
          id: entry.id,
          label: [manualProviderName(entry), method, entry.hint].filter(Boolean).join(", "),
          class: "model-setup-provider-select__option",
          type: "radio" as const,
          checked: selected,
          disabled: props.actionsDisabled,
          attributes: {
            "data-manual-provider": entry.id,
            "data-selected": selected ? "" : undefined,
            "data-initial-focus": selected ? "" : undefined,
          },
          icon: renderProviderIcon(props, entry, "model-setup__icon--picker"),
          content: (
            <span class="model-setup-provider-select__copy">
              <strong>{manualProviderName(entry)}</strong>
              {method ? <span>{method}</span> : undefined}
              {entry.hint ? <small>{entry.hint}</small> : undefined}
            </span>
          ),
        };
      }),
  );
  return (
    <Menu
      id={`manual-provider-${id}`}
      class="model-setup-provider-select"
      panelClass="model-setup-provider-select__menu"
      triggerClass="model-setup-provider-select__trigger"
      label={`${t("modelSetup.manual.provider")}: ${triggerLabel()}`}
      disabled={props.actionsDisabled || items().length === 0}
      items={items()}
      ref={(handle) => {
        menu = handle;
      }}
      tabFocusTarget={(backward) => (backward ? menu.overlay.trigger : props.nextTabTarget?.())}
      onSelect={(item) => {
        if (item.id !== props.manualProviderId) {
          props.onManualProviderChange(item.id);
        }
      }}
      trigger={
        <>
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
        </>
      }
    />
  );
}
