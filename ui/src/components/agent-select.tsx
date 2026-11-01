import type { JSX } from "@solidjs/web";
import { createMemo, onSettled, Show, type Accessor } from "solid-js";
import type { AgentIdentityResult } from "../api/types.ts";
import { resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { createIdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { AgentSelectOption } from "./agent-select-types.ts";
import { PickerContent } from "./select-picker-view.tsx";
import { Icon } from "./solid/icon.tsx";
import { useAvatarGatewayContext } from "./solid/identity-avatar-view.ts";
import { AgentOptionAvatar } from "./solid/identity-avatar.tsx";
import "../styles/select-picker.css";

type AgentSelectProps = {
  options: readonly AgentSelectOption[];
  value: string;
  placeholder: string;
  accessibleLabel: string;
  menuLabel: string;
  identityById: Record<string, AgentIdentityResult>;
  disabled: boolean;
  variant: "default" | "compact";
  onSelect: (value: string) => void;
  focusTargetsRef?: (readTargets: () => readonly HTMLElement[]) => void;
  identityTargetsRef?: (readTargets: () => readonly string[]) => void;
  onIdentityTargetsChange?: () => void;
};
export type AgentSelectElement = SolidBridgeElement<AgentSelectProps>;
defineSolidBridge<AgentSelectProps>(
  "openclaw-agent-select",
  (props, host) => {
    const selected = createMemo(() => props.options.find((option) => option.value === props.value));
    const fallbackOption = createMemo<AgentSelectOption | undefined>(() =>
      selected() || !props.value
        ? undefined
        : { value: props.value, label: props.value, agent: { id: props.value } },
    );
    const triggerOption = () => selected() ?? fallbackOption();
    const mountedRows = new Set<Accessor<AgentSelectOption>>();
    let active = false;
    let targetsQueued = false;
    const identityTargets = () =>
      active
        ? [
            ...new Set([
              triggerOption()?.agent?.id,
              ...[...mountedRows].map((row) => row().agent?.id),
            ]),
          ].filter((id): id is string => Boolean(id))
        : [];
    function notifyIdentityTargets() {
      if (targetsQueued) {
        return;
      }
      targetsQueued = true;
      // One settled window requests one batch, even when many rows mount together.
      queueMicrotask(() => {
        targetsQueued = false;
        if (active) {
          props.onIdentityTargetsChange?.();
        }
      });
    }
    onSettled(() => {
      active = true;
      props.identityTargetsRef?.(identityTargets);
      notifyIdentityTargets();
      return () => {
        active = false;
      };
    });
    const label = () => triggerOption()?.label ?? (props.placeholder || t("agents.noAgents"));
    const accessibleLabel = () => [label(), selected()?.badge].filter(Boolean).join(", ");
    const gateway = useAvatarGatewayContext();
    function Avatar(avatarProps: { option: AgentSelectOption }) {
      // Each mounted row owns one lease; windowing never resolves the hidden roster.
      const loader = createIdentityAvatars();
      onSettled(() => loader.connect());
      const source = projectOwner(loader, (owner) => owner);
      const avatar = createMemo(() => {
        gateway();
        const option = avatarProps.option;
        const identity = option.agent ? (props.identityById[option.agent.id] ?? null) : null;
        const url = option.agent ? resolveAgentAvatarUrl(option.agent, identity) : null;
        return source.read().withActiveRoutes(() => ({
          textAvatar: option.agent ? resolveAgentTextAvatar(option.agent, identity) : null,
          image: url ? loader.resolve(url) : null,
          onError: url ? loader.imageErrorHandler(url) : undefined,
        }));
      });
      return <AgentOptionAvatar option={avatarProps.option} avatar={avatar()} />;
    }
    function OptionRow(row: {
      option: Accessor<AgentSelectOption>;
      attributes: Accessor<JSX.HTMLAttributes<HTMLDivElement>>;
    }) {
      const isSelected = () => row.option().value === props.value;
      onSettled(() => {
        mountedRows.add(row.option);
        notifyIdentityTargets();
        return () => {
          mountedRows.delete(row.option);
          notifyIdentityTargets();
        };
      });
      return (
        <div
          {...row.attributes()}
          {...{ value: row.option().value }}
          class={[row.attributes().class, "oc-menu-item", "agent-select__option"]}
          data-agent-option=""
          data-selected={isSelected() ? "" : undefined}
          aria-label={[row.option().label, row.option().description, row.option().badge]
            .filter(Boolean)
            .join(", ")}
        >
          <span class="oc-menu-item__check" aria-hidden="true">
            {isSelected() ? "✓" : ""}
          </span>
          <span class="oc-menu-item__icon">
            <Avatar option={row.option()} />
          </span>
          <span class="oc-menu-item__label">
            <span class="agent-select__option-copy">
              <span class="agent-select__option-heading">
                <span class="agent-select__option-label">{row.option().label}</span>
                <Show when={row.option().badge}>
                  <span class="agent-select__badge">{row.option().badge}</span>
                </Show>
              </span>
              <Show when={row.option().description}>
                <span class="agent-select__option-description">{row.option().description}</span>
              </Show>
            </span>
          </span>
          <span class="oc-menu-item__details">
            <span class="agent-select__option-state" aria-hidden="true">
              <Show when={isSelected()}>
                <span class="agent-select__option-check">
                  <Icon name="check" />
                </span>
              </Show>
            </span>
          </span>
        </div>
      );
    }
    const renderers = {
      menuClass: "oc-menu agent-select__menu",
      header: (
        <Show when={props.menuLabel}>
          <div class="agent-select__menu-title">{props.menuLabel}</div>
        </Show>
      ),
      trigger: (attributes: Accessor<JSX.ButtonHTMLAttributes<HTMLButtonElement>>) => (
        <button
          {...attributes()}
          class="agent-select__trigger"
          aria-label={
            props.accessibleLabel
              ? `${props.accessibleLabel}: ${accessibleLabel()}`
              : accessibleLabel()
          }
        >
          <Show when={triggerOption()}>{(option) => <Avatar option={option()} />}</Show>
          <span class="agent-select__label">{label()}</span>
          <Show when={selected()?.badge}>
            <span class="agent-select__badge">{selected()?.badge}</span>
          </Show>
          <span class="agent-select__chevron" aria-hidden="true">
            <Icon name="chevronDown" />
          </span>
        </button>
      ),
      option: (
        attributes: Accessor<JSX.HTMLAttributes<HTMLDivElement>>,
        option: Accessor<AgentSelectOption>,
      ) => <OptionRow option={option} attributes={attributes} />,
    };
    return (
      <div class={["agent-select", { "agent-select--compact": props.variant === "compact" }]}>
        <PickerContent
          host={host}
          params={{
            get label() {
              return props.menuLabel || props.accessibleLabel || label();
            },
            get value() {
              return selected()?.value ?? null;
            },
            get options() {
              return props.options;
            },
            get disabled() {
              return props.disabled || props.options.length === 0;
            },
            searchable: true,
            // Agent menus have a fixed width; no offscreen sizing rows are needed.
            windowed: () => "",
            showOptionTooltips: false,
            focusRef: (handle) =>
              props.focusTargetsRef?.(() =>
                handle.elements().filter((element) => element.tabIndex >= 0),
              ),
            onChange: (value) => {
              if (
                !props.disabled &&
                value !== props.value &&
                props.options.some((option) => option.value === value && !option.disabled)
              ) {
                props.onSelect(value);
              }
            },
          }}
          renderers={renderers}
        />
      </div>
    );
  },
  {
    properties: {
      options: { default: [], attribute: false },
      value: { default: "", attribute: false },
      placeholder: { default: "", attribute: false },
      accessibleLabel: { default: "", attribute: false },
      menuLabel: { default: "", attribute: false },
      identityById: { default: {}, attribute: false },
      disabled: { default: false, attribute: false },
      variant: { default: "default", attribute: false },
      onSelect: { default: () => {}, attribute: false },
      focusTargetsRef: { default: undefined, attribute: false },
      identityTargetsRef: { default: undefined, attribute: false },
      onIdentityTargetsChange: { default: undefined, attribute: false },
    },
  },
);
