import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { AgentIdentityResult } from "../../api/types.ts";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import type { AgentSelectOption } from "../agent-select.ts";
import { avatarArtwork } from "../identity-avatar-view.ts";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";

export type AgentAvatarProps = {
  option: AgentSelectOption;
  identity: AgentIdentityResult | null;
};

export function AgentAvatarContent(props: AgentAvatarProps) {
  const [revision, refresh] = createSignal(0, { ownedWrite: true });
  const loader = new IdentityAvatarController(() => refresh((value) => value + 1));
  loader.hostConnected();
  onCleanup(() => loader.hostDisconnected());
  const avatar = createMemo(() => {
    revision();
    const option = props.option;
    const identity = props.identity;
    const url = option.agent ? resolveAgentAvatarUrl(option.agent, identity) : null;
    return loader.withActiveRoutes(() => ({
      image: url ? loader.resolve(url) : null,
      onError: url ? loader.imageErrorHandler(url) : undefined,
    }));
  });

  return (
    <Show
      when={!props.option.icon || Boolean(avatar().image)}
      fallback={
        <span
          ref={avatarArtwork(() => props.option.icon)}
          class="agent-select__avatar agent-select__avatar--icon"
          aria-hidden="true"
        />
      }
    >
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
