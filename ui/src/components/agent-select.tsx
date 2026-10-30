import { createMemo, createProjection, onSettled, Show } from "solid-js";
import type { AgentIdentityResult } from "../api/types.ts";
import { resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { createIdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { generateUUID } from "../lib/uuid.ts";
import type { AgentSelectOption } from "./agent-select-types.ts";
import { revealInScrollRegion } from "./scroll-state.ts";
import { Icon } from "./solid/icon.tsx";
import { useAvatarGatewayContext } from "./solid/identity-avatar-view.ts";
import { AgentOptionAvatar } from "./solid/identity-avatar.tsx";
import { Menu, type MenuItem, type MenuHandle, type MenuItemBindings } from "./solid/menu.tsx";

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
};
export type AgentSelectElement = SolidBridgeElement<AgentSelectProps>;
defineSolidBridge<AgentSelectProps>(
  "openclaw-agent-select",
  (props) => {
    const id = `agent-select-${generateUUID()}`;
    let menu: MenuHandle | undefined;
    const selected = createMemo(() => props.options.find((option) => option.value === props.value));
    const fallbackOption = createMemo<AgentSelectOption | undefined>(() =>
      selected() || !props.value
        ? undefined
        : { value: props.value, label: props.value, agent: { id: props.value } },
    );
    const triggerOption = () => selected() ?? fallbackOption();
    const label = () => triggerOption()?.label ?? (props.placeholder || t("agents.noAgents"));
    const accessibleLabel = () => [label(), selected()?.badge].filter(Boolean).join(", ");
    const gateway = useAvatarGatewayContext();
    const loader = createIdentityAvatars();
    onSettled(() => loader.connect());
    const avatarSource = projectOwner(loader, (owner) => owner);
    const avatars = createMemo(() => {
      gateway();
      const fallback = fallbackOption();
      const candidates = fallback ? [...props.options, fallback] : props.options;
      const identities = props.identityById;
      return avatarSource.read().withActiveRoutes(
        () =>
          new Map(
            candidates.map((option) => {
              const identity = option.agent ? (identities[option.agent.id] ?? null) : null;
              const url = option.agent ? resolveAgentAvatarUrl(option.agent, identity) : null;
              return [
                option.value,
                {
                  textAvatar: option.agent ? resolveAgentTextAvatar(option.agent, identity) : null,
                  image: url ? loader.resolve(url) : null,
                  onError: url ? loader.imageErrorHandler(url) : undefined,
                },
              ] as const;
            }),
          ),
      );
    });
    function Avatar(avatarProps: { option: AgentSelectOption }) {
      const resolved = () => avatars().get(avatarProps.option.value);
      return <AgentOptionAvatar option={avatarProps.option} avatar={resolved()} />;
    }
    // Menu retains a custom renderer per key; retain that key's live option fields too.
    const optionRows = createProjection(() => props.options, [], { key: "value" });
    function OptionRow(row: { option: AgentSelectOption; bindings: MenuItemBindings }) {
      const isSelected = createMemo(() => row.option.value === props.value);
      return (
        <button
          {...row.bindings}
          type="button"
          class="oc-menu-item agent-select__option"
          value={row.option.value}
          disabled={props.disabled || row.option.disabled}
          data-agent-option=""
          data-selected={isSelected() ? "" : undefined}
          data-initial-focus={
            isSelected() && !props.disabled && !row.option.disabled ? "" : undefined
          }
        >
          <span class="oc-menu-item__check" aria-hidden="true">
            {isSelected() ? "✓" : ""}
          </span>
          <span class="oc-menu-item__icon">
            <Avatar option={row.option} />
          </span>
          <span class="oc-menu-item__label">
            <span class="agent-select__option-copy">
              <span class="agent-select__option-heading">
                <span class="agent-select__option-label">{row.option.label}</span>
                <Show when={row.option.badge}>
                  <span class="agent-select__badge">{row.option.badge}</span>
                </Show>
              </span>
              <Show when={row.option.description}>
                <span class="agent-select__option-description">{row.option.description}</span>
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
        </button>
      );
    }
    const items = createProjection<readonly MenuItem[]>(
      () =>
        optionRows.map((option) => ({
          id: `option:${option.value}`,
          label: [option.label, option.description, option.badge].filter(Boolean).join(", "),
          type: "radio" as const,
          checked: option.value === props.value,
          disabled: props.disabled || option.disabled,
          render: (bindings: MenuItemBindings) => <OptionRow option={option} bindings={bindings} />,
        })),
      [],
      { key: "id" },
    );
    return (
      <Menu
        id={id}
        ref={(handle) => {
          menu = handle;
          props.focusTargetsRef?.(() => {
            const elements = handle.itemElements();
            const trigger = handle.overlay.trigger;
            return trigger ? [trigger, ...elements] : elements;
          });
        }}
        class={props.variant === "compact" ? "agent-select agent-select--compact" : "agent-select"}
        panelClass="agent-select__menu"
        triggerClass="agent-select__trigger"
        label={
          props.accessibleLabel
            ? `${props.accessibleLabel}: ${accessibleLabel()}`
            : accessibleLabel()
        }
        disabled={props.disabled || props.options.length === 0}
        items={items}
        placement="bottom-start"
        onAfterShow={() => {
          const surface = menu?.overlay.surface;
          const root = surface?.getRootNode();
          const option =
            root instanceof ShadowRoot ? root.activeElement : surface?.ownerDocument.activeElement;
          if (surface && option instanceof HTMLElement && surface.contains(option)) {
            revealInScrollRegion(surface, option);
          }
        }}
        trigger={
          <>
            <Show when={triggerOption()}>{(option) => <Avatar option={option()} />}</Show>
            <span class="agent-select__label">{label()}</span>
            <Show when={selected()?.badge}>
              <span class="agent-select__badge">{selected()?.badge}</span>
            </Show>
            <span class="agent-select__chevron" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
          </>
        }
        onSelect={(item) => {
          if (props.disabled) {
            return;
          }
          const picked = props.options.find((candidate) => `option:${candidate.value}` === item.id);
          if (picked && picked.value !== props.value) {
            props.onSelect(picked.value);
          }
        }}
      >
        <Show when={props.menuLabel}>
          <div class="agent-select__menu-title">{props.menuLabel}</div>
        </Show>
      </Menu>
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
    },
  },
);
