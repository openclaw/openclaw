import { createMemo, onSettled, Show } from "solid-js";
import type { AgentIdentityResult } from "../../api/types.ts";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { createIdentityAvatars } from "../../lib/identity-avatar-loader.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import type { AgentSelectOption } from "../agent-select.ts";
import { Icon } from "./icon.tsx";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";

export type AgentAvatarProps = {
  option: AgentSelectOption;
  identity: AgentIdentityResult | null;
};

export function AgentAvatarContent(props: AgentAvatarProps) {
  const loader = createIdentityAvatars();
  onSettled(() => loader.connect());
  const avatarSource = projectOwner(loader, (owner) => owner);
  const avatar = createMemo(() => {
    const option = props.option;
    const identity = props.identity;
    const url = option.agent ? resolveAgentAvatarUrl(option.agent, identity) : null;
    return avatarSource.read().withActiveRoutes(() => ({
      image: url ? loader.resolve(url) : null,
      onError: url ? loader.imageErrorHandler(url) : undefined,
    }));
  });

  return (
    <Show
      when={avatar().image ? undefined : props.option.icon}
      fallback={
        <AgentIdentityAvatar
          agent={{
            id: props.option.agent?.id ?? props.option.value,
            avatar: avatar().image,
            textAvatar: props.option.agent
              ? resolveAgentTextAvatar(props.option.agent, props.identity)
              : null,
          }}
          class="agent-select__avatar"
          onImageError={avatar().onError}
        />
      }
    >
      {(icon) => (
        <span class="agent-select__avatar agent-select__avatar--icon" aria-hidden="true">
          <Icon name={icon()} />
        </span>
      )}
    </Show>
  );
}

export type AgentAvatarElement = SolidBridgeElement<AgentAvatarProps>;
export const AgentAvatar = defineSolidBridge<AgentAvatarProps>(
  "openclaw-agent-avatar",
  (props) => {
    return <AgentAvatarContent {...props} />;
  },
  {
    properties: {
      option: { default: { value: "", label: "" }, attribute: false },
      identity: { default: null, attribute: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-avatar": AgentAvatarElement;
  }
}
