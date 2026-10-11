import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { renderSessionProgressCard } from "../components/session-progress-card.ts";
import { AgentAvatar } from "../components/solid/agent-avatar.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { SanitizedHtml } from "../components/solid/sanitized-html.tsx";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import { extractText } from "../lib/chat/message-extract.ts";
import { normalizeMessage } from "../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../lib/chat/sender-label.ts";
import { projectGateway, projectGatewayEvents } from "../lib/reactive/application.ts";
import { projectProgressCard } from "../lib/reactive/domain-keyed.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { readSessionChangedEvent } from "../lib/sessions/reconcile.ts";
import { uiSessionEventMatches, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { defineSolidBridge, LitContent, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { renderChatAuthorAvatar } from "../pages/chat/components/chat-author-avatar.ts";
import "../styles/chat/progress-card.css";
import "../styles/sidebar-markdown.css";
import "../styles/plugin-session-summary.css";

export type PluginSessionSummaryProps = {
  session: BoardGetParams | null;
  gateway: ApplicationGateway | null;
  presented: boolean;
  agents: AgentsListResult["agents"];
  agentIdentity: AgentIdentityCapability | null;
};

type SummaryScope = {
  gateway: ApplicationGateway;
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>;
  revision: number;
  signal: AbortSignal;
  session: BoardGetParams;
};

function SessionHistory(props: PluginSessionSummaryProps & { scope: SummaryScope }) {
  const scope = untrack(() => props.scope);
  const [history, setHistory] = createSignal<ChatHistoryResult | null>(null);
  const [error, setError] = createSignal(false);
  let alive = true;
  let pending = false;
  let dirty = false;
  const current = () =>
    untrack(
      () =>
        alive &&
        !scope.signal.aborted &&
        props.presented &&
        props.gateway === scope.gateway &&
        scope.gateway.snapshot.phase === "connected" &&
        scope.gateway.snapshot.client === scope.client &&
        scope.gateway.connectionRevision === scope.revision &&
        props.session?.sessionKey === scope.session.sessionKey &&
        props.session?.agentId === scope.session.agentId,
    );
  onCleanup(() => {
    alive = false;
  });
  const store = sessionProgressCardsForGateway(scope.gateway);
  const progress = projectProgressCard({
    store,
    target: scope.session,
    options: { admitAutomaticRead: current },
  });
  const events = projectGatewayEvents(scope.gateway);
  const refresh = async () => {
    if (!current()) {
      return;
    }
    if (pending) {
      dirty = true;
      return;
    }
    pending = true;
    dirty = false;
    setError(false);
    try {
      const result = await scope.client.request<ChatHistoryResult>("chat.history", {
        ...scope.session,
        toolResultMaxChars: 2_000,
        limit: 20,
        maxChars: 12000,
      });
      if (current()) {
        setHistory(result);
      }
    } catch {
      if (current()) {
        setError(true);
      }
    } finally {
      if (current()) {
        pending = false;
        if (dirty) {
          void refresh();
        }
      }
    }
  };
  onCleanup(
    events.subscribe((event) => {
      if (event.event !== "sessions.changed" && event.event !== "session.message") {
        return;
      }
      const changed = readSessionChangedEvent(event.payload);
      if (
        changed &&
        current() &&
        uiSessionEventMatches(
          {
            ...scope.gateway.snapshot,
            sessionKey: scope.session.sessionKey,
            assistantAgentId: scope.session.agentId ?? scope.gateway.snapshot.assistantAgentId,
          },
          changed.key,
          changed.agentId,
        )
      ) {
        void refresh();
      }
    }),
  );
  onSettled(() => {
    void refresh();
  });
  const messages = createMemo(() =>
    (history()?.messages ?? []).slice(-20).flatMap((message) => {
      if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
        return [];
      }
      const selectedText = extractText(message);
      if (!selectedText) {
        return [];
      }
      // Select the visible assistant phase before normalization drops block signatures.
      const preview = normalizeMessage({ role: message.role, content: selectedText });
      const text = preview.content
        .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
        .join("\n");
      if (!text) {
        return [];
      }
      const normalized = normalizeMessage(message);
      const sender = normalized.sender;
      const senderAgentId =
        normalized.senderSession?.agentId ??
        parseAgentSessionKey(normalized.senderSession?.sessionKey)?.agentId;
      const agentId = normalized.senderSession
        ? senderAgentId
        : message.role === "assistant"
          ? (scope.session.agentId ?? parseAgentSessionKey(scope.session.sessionKey)?.agentId)
          : undefined;
      const agent = agentId ? props.agents.find((entry) => entry.id === agentId) : undefined;
      const label =
        formatSenderLabel(sender) ??
        agent?.name ??
        agent?.identity?.name ??
        (agentId || t(message.role === "user" ? "sessionsView.user" : "sessionsView.assistant"));
      const timestamp =
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? new Date(message.timestamp)
          : null;
      const time = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null;
      return [{ text, label, sender, agentId, agent, time, role: message.role }];
    }),
  );
  const identity = createMemo(() => props.agentIdentity);
  const identities = createMemo(() => {
    const source = identity();
    return source
      ? projectSource(source, {
          read: (owner) => owner,
          subscribe: (owner, notify) => owner.subscribe(notify),
          equality: "revision",
        })
      : null;
  });
  createEffect(
    () => ({
      owner: identities()?.read(),
      ids: messages().flatMap((message) =>
        !message.sender && message.agentId ? [message.agentId] : [],
      ),
    }),
    ({ owner, ids }) => {
      void owner?.ensure(ids);
    },
  );
  return (
    <div class="plugin-session-summary">
      <Show when={progress.read().error || progress.read().card !== null}>
        <section class="plugin-session-summary__progress">
          {progress.read().error ? (
            <p role="alert">{t("sessionProgressCard.widgetUnavailable")}</p>
          ) : progress.read().card === undefined ? (
            <p>{t("sessionProgressCard.widgetLoading")}</p>
          ) : (
            <LitContent
              render={() =>
                renderSessionProgressCard(
                  progress.read().card,
                  "board",
                  undefined,
                  history()?.sessionInfo?.status,
                  history()?.sessionInfo?.startedAt,
                  history()?.sessionInfo?.endedAt,
                  history()?.sessionInfo?.hasActiveRun === true,
                )
              }
            />
          )}
        </section>
      </Show>
      <section
        class="plugin-session-summary__history"
        aria-label={t("pluginUi.sessionRecentMessages")}
      >
        <h3>{t("pluginUi.sessionRecentMessages")}</h3>
        {error() ? (
          <p role="alert">{t("pluginUi.sessionHistoryUnavailable")}</p>
        ) : !history() ? (
          <p>{t("common.loading")}</p>
        ) : (
          <For
            keyed={false}
            each={messages()}
            fallback={<p>{t("pluginUi.sessionHistoryEmpty")}</p>}
          >
            {(message) => (
              <article class="plugin-session-summary__message">
                <header class="plugin-session-summary__message-header">
                  <span class="plugin-session-summary__avatar">
                    {message().sender ? (
                      <LitContent render={() => renderChatAuthorAvatar(message().sender)} />
                    ) : message().agentId ? (
                      <AgentAvatar
                        option={{
                          value: message().agentId!,
                          label: message().label,
                          agent: message().agent ?? { id: message().agentId! },
                        }}
                        identity={identities()?.read().get(message().agentId) ?? null}
                      />
                    ) : (
                      <span class="plugin-session-summary__unknown" aria-hidden="true">
                        <Icon name={message().role === "user" ? "users" : "bot"} />
                      </span>
                    )}
                  </span>
                  <strong class="plugin-session-summary__role">{message().label}</strong>
                  <Show when={message().time}>
                    {(time) => (
                      <time datetime={time().toISOString()} title={time().toLocaleString()}>
                        {time().toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    )}
                  </Show>
                </header>
                <SanitizedHtml
                  class="sidebar-markdown"
                  html={toSanitizedMarkdownHtml(message().text)}
                />
              </article>
            )}
          </For>
        )}
      </section>
      <Show when={error() || progress.read().error}>
        <button
          class="btn"
          onClick={() => {
            void refresh();
            void store.load(scope.session).catch(() => undefined);
          }}
        >
          {t("common.retry")}
        </button>
      </Show>
    </div>
  );
}

function PluginSessionSummaryContent(props: PluginSessionSummaryProps) {
  const gateway = createMemo(() => (props.presented ? props.gateway : null));
  const projection = createMemo(() => {
    const current = gateway();
    if (!current) {
      return null;
    }
    const state = projectGateway(current);
    let connection = new AbortController();
    const stop = state.subscribe(() => {
      // Retire while the owner publishes; Solid may only see the final reconnected snapshot.
      if (state.read().snapshot.phase !== "connected") {
        connection.abort();
      } else if (connection.signal.aborted) {
        connection = new AbortController();
      }
    });
    onCleanup(() => {
      stop();
      connection.abort();
    });
    return {
      read: state.read,
      get signal() {
        return connection.signal;
      },
    };
  });
  const scope = createMemo<SummaryScope | null>(
    () => {
      const current = gateway();
      const connection = projection();
      const state = connection?.read();
      return current &&
        connection &&
        state?.snapshot.phase === "connected" &&
        state.snapshot.client &&
        props.session
        ? {
            gateway: current,
            client: state.snapshot.client,
            revision: state.connectionRevision,
            signal: connection.signal,
            session: { ...props.session },
          }
        : null;
    },
    {
      equals: (left, right) =>
        left?.gateway === right?.gateway &&
        left?.client === right?.client &&
        left?.revision === right?.revision &&
        left?.signal === right?.signal &&
        left?.session.sessionKey === right?.session.sessionKey &&
        left?.session.agentId === right?.session.agentId,
    },
  );
  return (
    <Show when={props.presented}>
      <Show
        when={scope()}
        keyed
        fallback={<p role="status">{t("pluginUi.sessionHistoryUnavailable")}</p>}
      >
        {(current) => <SessionHistory {...props} scope={current} />}
      </Show>
    </Show>
  );
}

export const PluginSessionSummary = defineSolidBridge<PluginSessionSummaryProps>(
  "openclaw-plugin-session-summary",
  PluginSessionSummaryContent,
  {
    properties: {
      session: { default: null, attribute: false },
      gateway: { default: null, attribute: false },
      presented: { default: false, attribute: false },
      agents: { default: [], attribute: false },
      agentIdentity: { default: null, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-session-summary": SolidBridgeElement<PluginSessionSummaryProps>;
  }
}
