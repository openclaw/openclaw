import { html } from "lit";
import {
  viDashboardI18nText as i18nText,
  viDashboardText as uiText,
} from "../vi-dashboard-text.ts";
import {
  agentLogoUrl,
  assistantAvatarFallbackUrl,
  resolveChatAvatarRenderUrl,
  resolveAssistantTextAvatar,
} from "../views/agents-utils.ts";

export type ChatWelcomeProps = {
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  basePath?: string;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

const WELCOME_SUGGESTIONS = [
  {
    key: "chat.welcome.suggestions.whatCanYouDo",
    vi: "Bạn có thể làm gì?",
  },
  {
    key: "chat.welcome.suggestions.summarizeRecentSessions",
    vi: "Tóm tắt các phiên gần đây của tôi",
  },
  {
    key: "chat.welcome.suggestions.configureChannel",
    vi: "Giúp tôi cấu hình một kênh",
  },
  {
    key: "chat.welcome.suggestions.checkSystemHealth",
    vi: "Kiểm tra tình trạng hệ thống",
  },
];

function resolveAssistantAvatarUrl(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
}

export function resolveAssistantDisplayAvatar(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveAssistantAvatarUrl(props) ?? resolveAssistantTextAvatar(props.assistantAvatar);
}

export function renderWelcomeState(props: ChatWelcomeProps) {
  const name = props.assistantName || uiText("Assistant", "Trợ lý");
  const avatar = resolveAssistantAvatarUrl(props);
  const avatarText = avatar ? null : resolveAssistantTextAvatar(props.assistantAvatar);
  const fallbackAvatarUrl = assistantAvatarFallbackUrl(props.basePath ?? "");
  const logoUrl = agentLogoUrl(props.basePath ?? "");

  return html`
    <div class="agent-chat__welcome" style="--agent-color: var(--accent)">
      <div class="agent-chat__welcome-glow"></div>
      ${avatar
        ? html`<img
            src=${avatar}
            alt=${name}
            style="width:56px; height:56px; border-radius:50%; object-fit:cover;"
          />`
        : avatarText
          ? html`<div class="agent-chat__avatar agent-chat__avatar--text" aria-label=${name}>
              ${avatarText}
            </div>`
          : html`<div class="agent-chat__avatar agent-chat__avatar--logo">
              <img src=${fallbackAvatarUrl} alt=${name} />
            </div>`}
      <h2>${name}</h2>
      <div class="agent-chat__badges">
        <span class="agent-chat__badge"
          ><img src=${logoUrl} alt="" /> ${i18nText("chat.welcome.ready", "Sẵn sàng chat")}</span
        >
      </div>
      <p class="agent-chat__hint">
        ${i18nText("chat.welcome.hintBeforeShortcut", "Nhập tin nhắn bên dưới ·")}
        <kbd>/</kbd> ${i18nText("chat.welcome.hintAfterShortcut", "để mở lệnh")}
      </p>
      <div class="agent-chat__suggestions">
        ${WELCOME_SUGGESTIONS.map(({ key, vi }) => {
          const text = i18nText(key, vi);
          return html`
            <button
              type="button"
              class="agent-chat__suggestion"
              @click=${() => {
                props.onDraftChange(text);
                props.onSend();
              }}
            >
              ${text}
            </button>
          `;
        })}
      </div>
    </div>
  `;
}
