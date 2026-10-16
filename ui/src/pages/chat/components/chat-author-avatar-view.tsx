import { createMemo, Show } from "solid-js";
import { ChannelAvatar } from "../../../components/solid/channel-avatar.tsx";
import {
  IdentityAvatarImage,
  identityAvatarState,
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

type ChatAuthorAvatarProps = {
  sender: IdentityAvatarInput | null | undefined;
  class?: string;
  agentAvatar?: { avatar?: string | null; textAvatar?: string | null };
  channelAvatar?: ChannelSenderAvatarSource;
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
  const gateway = useAvatarGatewayContext();
  const label = createMemo(() => formatSenderLabel(props.sender));
  const avatar = createMemo(() => {
    gateway();
    const value = props.sender ? resolveAvatar(props.sender) : undefined;
    return value?.kind === "profile" ? value.url : null;
  });
  return (
    <Show when={props.sender && label() ? props.sender : undefined}>
      {(sender) => (
        <Show
          when={sender().identity?.type === "agent"}
          fallback={
            <IdentityAvatar identity={sender()}>
              {(view) => (
                <ProfileAuthorAvatar
                  view={view()}
                  sender={sender()}
                  label={label()!}
                  channelAvatar={props.channelAvatar}
                />
              )}
            </IdentityAvatar>
          }
        >
          <span
            class={props.class ?? "chat-author-avatar"}
            role="img"
            aria-label={label()!}
            title={label()!}
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

function ProfileAuthorAvatar(props: {
  view: IdentityAvatarView;
  sender: IdentityAvatarInput;
  label: string;
  channelAvatar?: ChannelSenderAvatarSource;
}) {
  const gateway = useAvatarGatewayContext();
  const channelPhoto = createMemo(() =>
    resolveChannelSenderAvatarUrl(props.sender, props.channelAvatar, gateway().resourceBasePath),
  );
  return (
    <span
      ref={identityAvatarState(() => props.view)}
      class="chat-author-avatar"
      role="img"
      aria-label={props.label}
      title={props.label}
    >
      <Show
        when={channelPhoto()}
        fallback={
          <>
            <Show when={Boolean(props.view.imageUrl)}>
              <IdentityAvatarImage
                view={props.view}
                fallbackSelector=".chat-author-avatar"
                class="chat-author-avatar__image"
                ariaHidden
              />
            </Show>
            <InitialsAvatar avatar={props.view.fallback} fallback={Boolean(props.view.imageUrl)} />
          </>
        }
      >
        <ChannelAvatar
          routeUrl={channelPhoto()}
          authTokens={gateway().authTokens}
          authReady={Boolean(gateway().origin)}
        >
          <InitialsAvatar avatar={props.view.fallback} />
        </ChannelAvatar>
      </Show>
    </span>
  );
}

/** Image failure reveals the same initials without replacing the avatar frame. */
export function UserAvatarSlot(props: { view: IdentityAvatarView; label: string }) {
  return (
    <Show when={Boolean(props.view.imageUrl)} fallback={<UserInitials {...props} />}>
      <span ref={identityAvatarState(() => props.view)} class="chat-avatar-slot">
        <IdentityAvatarImage
          view={props.view}
          fallbackSelector=".chat-avatar-slot"
          class="chat-avatar user"
          alt={props.label}
        />
        <UserInitials {...props} />
      </span>
    </Show>
  );
}

function UserInitials(props: { view: IdentityAvatarView; label: string }) {
  return (
    <div
      class="chat-avatar user chat-avatar--sender-initials"
      style={{ background: `hsl(${props.view.fallback.colorSeed % 360} 48% 42%)` }}
      role="img"
      aria-label={props.label}
    >
      {props.view.fallback.initials}
    </div>
  );
}
