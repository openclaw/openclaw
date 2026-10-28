import { createMemo, Show } from "solid-js";
import { ChannelAvatar } from "../../../components/solid/channel-avatar.tsx";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "../../../components/solid/identity-avatar-image.tsx";
import { useAvatarGatewayContext } from "../../../components/solid/identity-avatar-view.ts";
import { AgentIdentityAvatar, IdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import {
  resolveChannelSenderAvatarUrl,
  type ChannelSenderAvatarSource,
} from "../../../lib/chat/channel-sender-avatar.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import type { IdentityAvatarView } from "../../../lib/identity-avatar-view.ts";
import {
  resolveAvatar,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../../../lib/identity-avatar.ts";

export type ChatAuthorAvatarProps = {
  elementRef?: (element: HTMLElement) => void;
  sender: IdentityAvatarInput | null | undefined;
  class?: string;
  agentAvatar?: { avatar?: string | null; textAvatar?: string | null };
  channelAvatar?: ChannelSenderAvatarSource;
  hideTooltip?: boolean;
};

function InitialsAvatar(props: {
  avatar: Extract<ResolvedIdentityAvatar, { kind: "initials" }>;
  fallback?: boolean;
}) {
  return (
    <span
      class={["chat-author-avatar__initials", { "chat-author-avatar__fallback": props.fallback }]}
      style={{ "--chat-author-avatar-hue": props.avatar.colorSeed % 360 }}
      aria-hidden="true"
    >
      {props.avatar.initials}
    </span>
  );
}

/** Small author marker shared by transcript bubbles and the pending-send queue. */
export function ChatAuthorAvatar(props: ChatAuthorAvatarProps) {
  const authorGateway = useAvatarGatewayContext();
  const label = () => formatSenderLabel(props.sender);
  const avatar = createMemo(() => {
    authorGateway();
    const value = props.sender ? resolveAvatar(props.sender) : undefined;
    return value?.kind === "profile" ? value.url : null;
  });
  function ProfileAuthorAvatar(childProps: {
    view: IdentityAvatarView;
    sender: IdentityAvatarInput;
    label: string;
  }) {
    const gateway = useAvatarGatewayContext();
    const channelPhoto = createMemo(() =>
      resolveChannelSenderAvatarUrl(
        childProps.sender,
        props.channelAvatar,
        gateway().resourceBasePath,
      ),
    );
    const presentation = createIdentityAvatarPresentation(() => childProps.view);
    return (
      <span
        ref={(element) => props.elementRef?.(element)}
        data-avatar-state={channelPhoto() ? undefined : presentation.state()}
        class={["chat-author-avatar", channelPhoto() ? undefined : presentation.classes()]}
        role="img"
        aria-label={childProps.label}
        title={props.hideTooltip ? undefined : childProps.label}
      >
        <Show
          when={channelPhoto()}
          fallback={
            <>
              <Show when={Boolean(childProps.view.imageUrl)}>
                <IdentityAvatarImage
                  view={childProps.view}
                  onStateChange={presentation.onStateChange}
                  class="chat-author-avatar__image"
                  ariaHidden
                />
              </Show>
              <InitialsAvatar
                avatar={childProps.view.fallback}
                fallback={Boolean(childProps.view.imageUrl)}
              />
            </>
          }
        >
          <ChannelAvatar
            routeUrl={channelPhoto()}
            authTokens={gateway().authTokens}
            authReady={Boolean(gateway().origin)}
          >
            <InitialsAvatar avatar={childProps.view.fallback} />
          </ChannelAvatar>
        </Show>
      </span>
    );
  }

  return (
    <Show when={props.sender && label() ? props.sender : undefined}>
      {(sender) => (
        <Show
          when={sender().identity?.type === "agent"}
          fallback={
            <IdentityAvatar identity={sender()}>
              {(view) => <ProfileAuthorAvatar view={view()} sender={sender()} label={label()!} />}
            </IdentityAvatar>
          }
        >
          <span
            ref={(element) => props.elementRef?.(element)}
            class={props.class ?? "chat-author-avatar"}
            role="img"
            aria-label={label()!}
            title={props.hideTooltip ? undefined : label()!}
          >
            <AgentIdentityAvatar
              agent={{
                id: sender().identity!.id,
                avatar: props.agentAvatar?.avatar ?? avatar(),
                textAvatar: props.agentAvatar?.textAvatar,
              }}
            />
          </span>
        </Show>
      )}
    </Show>
  );
}

/** Image failure reveals the same initials without replacing the avatar frame. */
export function UserAvatarSlot(props: {
  view: IdentityAvatarView;
  label: string;
  elementRef?: (element: HTMLElement) => void;
}) {
  const presentation = createIdentityAvatarPresentation(() => props.view);
  return (
    <Show when={Boolean(props.view.imageUrl)} fallback={<UserInitials {...props} />}>
      <span
        ref={(element) => props.elementRef?.(element)}
        data-avatar-state={presentation.state()}
        class={["chat-avatar-slot", presentation.classes()]}
        role="img"
        aria-label={props.label}
      >
        <IdentityAvatarImage
          view={props.view}
          onStateChange={presentation.onStateChange}
          class="chat-avatar user"
          alt={props.label}
          ariaHidden
        />
        <UserInitials view={props.view} />
      </span>
    </Show>
  );
}

function UserInitials(props: {
  view: IdentityAvatarView;
  label?: string;
  elementRef?: (element: HTMLElement) => void;
}) {
  return (
    <div
      ref={(element) => props.elementRef?.(element)}
      class="chat-avatar user chat-avatar--sender-initials"
      style={{ background: `hsl(${props.view.fallback.colorSeed % 360} 48% 42%)` }}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      {props.view.fallback.initials}
    </div>
  );
}
