import { createMemo, Show } from "solid-js";
import { isReservedSystemAgentId } from "../../../../src/system-agent/agent-id.js";
import type { AgentsListResult } from "../../api/types.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import {
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
  resolveLocalUserName,
} from "../../app/user-identity.ts";
import { ChannelAvatar } from "../../components/solid/channel-avatar.tsx";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "../../components/solid/identity-avatar-image.tsx";
import { useAvatarGatewayContext } from "../../components/solid/identity-avatar-view.ts";
import {
  AgentAvatarHat,
  AgentIdentityAvatar,
  IdentityAvatar,
} from "../../components/solid/identity-avatar.tsx";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import type { AssistantIdentity } from "../../lib/assistant-identity.ts";
import {
  isRenderableControlUiAvatarUrl,
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
} from "../../lib/avatar.ts";
import {
  resolveChannelSenderAvatarUrl,
  type ChannelSenderAvatarSource,
} from "../../lib/chat/channel-sender-avatar.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { formatSenderLabel, type SenderIdentity } from "../../lib/chat/sender-label.ts";
import { resolveAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import type { IdentityAvatarView } from "../../lib/identity-avatar-view.ts";
import { resolveAvatarInitials } from "../../lib/identity-avatar.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { DEFAULT_AGENT_ID } from "../../lib/sessions/session-key.ts";
import { ChatAuthorAvatar, UserAvatarSlot } from "./components/chat-author-avatar-view.tsx";

export type ChatAvatarProps = {
  elementRef?: (element: HTMLElement) => void;
  mediaReadAllowed?: boolean;
  role: string;
  assistant?: Pick<AssistantIdentity, "agentId" | "name" | "avatar"> & {
    textAvatar?: string | null;
  };
  user?: { name?: string | null; avatar?: string | null };
  sender?: SenderIdentity | null;
  channelAvatar?: ChannelSenderAvatarSource;
};

export function ChatAvatar(props: ChatAvatarProps) {
  const role = () => normalizeRoleForGrouping(props.role);
  return (
    <Show
      when={props.mediaReadAllowed !== false}
      fallback={
        <div class={["chat-avatar", role()]} ref={(element) => props.elementRef?.(element)}>
          <RoleAvatarIcon role={role()} />
        </div>
      }
    >
      <Show
        when={role() === "user" && props.sender ? props.sender : undefined}
        fallback={
          <Show
            when={role() === "assistant"}
            fallback={<LocalAvatar role={role()} user={props.user} elementRef={props.elementRef} />}
          >
            <AgentAvatar
              elementRef={props.elementRef}
              id={props.assistant?.agentId ?? DEFAULT_AGENT_ID}
              name={props.assistant?.name?.trim() || "Assistant"}
              avatar={props.assistant?.avatar}
              textAvatar={
                props.assistant?.textAvatar ?? resolveAssistantTextAvatar(props.assistant?.avatar)
              }
            />
          </Show>
        }
      >
        {(sender) => (
          <Show
            when={sender().identity?.type === "agent"}
            fallback={
              <IdentityAvatar identity={sender()}>
                {(view) => (
                  <ProfileChatAvatar
                    elementRef={props.elementRef}
                    sender={sender()}
                    view={view()}
                    channelAvatar={props.channelAvatar}
                  />
                )}
              </IdentityAvatar>
            }
          >
            <ChatAuthorAvatar
              sender={sender()}
              class="chat-avatar assistant"
              elementRef={props.elementRef}
            />
          </Show>
        )}
      </Show>
    </Show>
  );
}

function ProfileChatAvatar(props: {
  elementRef?: (element: HTMLElement) => void;
  sender: SenderIdentity;
  view: IdentityAvatarView;
  channelAvatar?: ChannelSenderAvatarSource;
}) {
  const gateway = useAvatarGatewayContext();
  const label = () => formatSenderLabel(props.sender) ?? "";
  const photo = createMemo(() =>
    resolveChannelSenderAvatarUrl(props.sender, props.channelAvatar, gateway().resourceBasePath),
  );
  return (
    <Show
      when={photo()}
      fallback={<UserAvatarSlot view={props.view} label={label()} elementRef={props.elementRef} />}
    >
      <div
        ref={(element) => props.elementRef?.(element)}
        class="chat-avatar user chat-avatar--sender-initials"
        role="img"
        aria-label={label()}
        style={{ background: `hsl(${props.view.fallback.colorSeed % 360} 48% 42%)` }}
      >
        <ChannelAvatar
          routeUrl={photo()}
          authTokens={gateway().authTokens}
          authReady={Boolean(gateway().origin)}
        >
          {props.view.fallback.initials}
        </ChannelAvatar>
      </div>
    </Show>
  );
}

function LocalAvatar(props: Pick<ChatAvatarProps, "role" | "user" | "elementRef">) {
  const gateway = useAvatarGatewayContext();
  const name = createMemo(() => resolveLocalUserName(props.user));
  const url = createMemo(() => resolveLocalUserAvatarUrl(props.user));
  const text = createMemo(() => resolveLocalUserAvatarText(props.user));
  const view = createMemo(() => {
    gateway();
    const source = url();
    const imageUrl = source ? resolveAvatarImageUrl(source, source) : null;
    return {
      fallback: resolveAvatarInitials({ name: name() }),
      imageUrl,
      pending: imageUrl !== null && typeof imageUrl !== "string",
    };
  });
  return (
    <Show
      when={props.role === "user" && url()}
      fallback={
        <div
          ref={(element) => props.elementRef?.(element)}
          class={[
            "chat-avatar",
            props.role === "user" ? "user" : props.role === "tool" ? "tool" : "other",
          ]}
          role={props.role === "user" && text() ? "img" : undefined}
          aria-label={props.role === "user" && text() ? name() : undefined}
        >
          <Show
            when={props.role === "user" && text()}
            fallback={<RoleAvatarIcon role={props.role} />}
          >
            {text()}
          </Show>
        </div>
      }
    >
      <UserAvatarSlot view={view()} label={name()} elementRef={props.elementRef} />
    </Show>
  );
}

function RoleAvatarIcon(props: { role: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <Show
        when={props.role === "user"}
        fallback={
          <Show
            when={props.role === "tool"}
            fallback={
              <>
                <circle cx="12" cy="12" r="10" />
                <text
                  x="12"
                  y="16.5"
                  text-anchor="middle"
                  font-size="14"
                  font-weight="600"
                  fill="var(--bg, #fff)"
                >
                  ?
                </text>
              </>
            }
          >
            <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53a7.76 7.76 0 0 0 .07-1 7.76 7.76 0 0 0-.07-.97l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.15 7.15 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65a7.15 7.15 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64L4.57 11a7.9 7.9 0 0 0 0 1.94l-2.11 1.69a.49.49 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.72 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.23 0 .44-.18.49-.42l.38-2.65a7.15 7.15 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64z" />
          </Show>
        }
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M20 21a8 8 0 1 0-16 0" />
      </Show>
    </svg>
  );
}

function AgentAvatar(props: {
  elementRef?: (element: HTMLElement) => void;
  id: string;
  name: string;
  avatar?: string | null;
  textAvatar?: string | null;
}) {
  const gateway = useAvatarGatewayContext();
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const url = createMemo(() => props.avatar?.trim() || "");
  const view = createMemo(() => {
    gateway();
    const imageUrl = resolveAvatarImageUrl(url(), url());
    return { imageUrl, pending: imageUrl !== null && typeof imageUrl !== "string" };
  });
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <Show
      when={
        !isReservedSystemAgentId(props.id) &&
        (url().startsWith("blob:") || isRenderableControlUiAvatarUrl(url()))
      }
      fallback={
        <AgentIdentityAvatar
          elementRef={props.elementRef}
          agent={{ id: props.id, name: props.name, textAvatar: props.textAvatar }}
          class="chat-avatar assistant"
        />
      }
    >
      <span
        ref={(element) => props.elementRef?.(element)}
        data-avatar-state={presentation.state()}
        class={["chat-avatar-slot", presentation.classes()]}
      >
        <Show when={Boolean(view().imageUrl)}>
          <IdentityAvatarImage
            view={view()}
            onStateChange={presentation.onStateChange}
            class="chat-avatar assistant"
            alt={props.name}
          />
        </Show>
        <AgentIdentityAvatar
          agent={{ id: props.id, name: props.name, textAvatar: props.textAvatar }}
          class="chat-avatar assistant"
        />
        <AgentAvatarHat agentId={props.id} branding={branding.read()} />
      </span>
    </Show>
  );
}

export type ForwardedAvatarOptions = {
  mediaReadAllowed?: boolean;
  agentId?: string;
  agents?: AgentsListResult["agents"];
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  assistantName?: string;
  assistantAvatar?: string | null;
  assistantTextAvatar?: string | null;
};

export function ForwardedAvatar(props: {
  agentId?: string;
  options: ForwardedAvatarOptions;
  elementRef?: (element: HTMLElement) => void;
}) {
  const agent = createMemo(() =>
    props.agentId
      ? props.options.agents?.find((candidate) => candidate.id === props.agentId)
      : undefined,
  );
  const avatar = createMemo(() => {
    const value = agent();
    return value
      ? (props.options.senderAgentAvatars?.get(value.id) ?? resolveAgentAvatarUrl(value))
      : null;
  });
  return (
    <Show
      when={props.options.mediaReadAllowed !== false}
      fallback={
        <ChatAvatar role="assistant" mediaReadAllowed={false} elementRef={props.elementRef} />
      }
    >
      <Show
        when={props.agentId && props.agentId === props.options.agentId}
        fallback={
          <Show when={agent()}>
            {(value) => (
              <AgentAvatar
                elementRef={props.elementRef}
                id={value().id}
                name={value().identity?.name?.trim() || value().id}
                avatar={avatar()}
                textAvatar={resolveAssistantTextAvatar(avatar()) ?? resolveAgentTextAvatar(value())}
              />
            )}
          </Show>
        }
      >
        <ChatAvatar
          elementRef={props.elementRef}
          role="assistant"
          assistant={{
            agentId: props.agentId,
            name: props.options.assistantName ?? "Assistant",
            avatar: props.options.assistantAvatar ?? null,
            textAvatar: props.options.assistantTextAvatar,
          }}
        />
      </Show>
    </Show>
  );
}
