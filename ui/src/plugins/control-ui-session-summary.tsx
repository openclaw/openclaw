import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  createStore,
  isPending,
  onCleanup,
  onSettled,
} from "solid-js";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { SessionProgressCard } from "../components/session-progress-card-solid.tsx";
import { AgentAvatar } from "../components/solid/agent-avatar.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { SanitizedHtml } from "../components/solid/sanitized-html.tsx";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import { extractText } from "../lib/chat/message-extract.ts";
import { normalizeMessage } from "../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../lib/chat/sender-label.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { projectProgressCard } from "../lib/reactive/domain-keyed.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { createSessionEventRefreshCoordinator } from "../lib/sessions/event-refresh-coordinator.ts";
import { readSessionChangedEvent } from "../lib/sessions/reconcile.ts";
import { uiSessionEventMatches, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type {
  ChatHistoryResponse,
  ChatHistoryResult,
} from "../pages/chat/chat-history-snapshot.ts";
import { ChatAuthorAvatar } from "../pages/chat/components/chat-author-avatar.ts";
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

function SessionHistory(props: PluginSessionSummaryProps, scope: SummaryScope) {
  const [read, setRead] = createSignal<Promise<ChatHistoryResult | null> | null>(null);
  const history = createMemo(() => read() ?? null);
  // The stable progress card keeps metadata from the last accepted history read.
  const [metadata, setMetadata] = createStore<{
    sessionInfo: ChatHistoryResult["sessionInfo"];
  }>({ sessionInfo: undefined }, { shallow: true });
  let alive = true;
  let snapshot: ChatHistoryResult | null = null;
  let cursor: string | undefined;
  const current = () =>
    alive &&
    !scope.signal.aborted &&
    props.presented &&
    props.gateway === scope.gateway &&
    scope.gateway.snapshot.phase === "connected" &&
    scope.gateway.snapshot.client === scope.client &&
    scope.gateway.connectionRevision === scope.revision &&
    props.session?.sessionKey === scope.session.sessionKey &&
    props.session?.agentId === scope.session.agentId;
  const store = sessionProgressCardsForGateway(scope.gateway);
  const progress = projectProgressCard(() => ({
    store,
    target: scope.session,
    options: { admitAutomaticRead: current },
  }));
  const refresh = () => {
    if (!current()) {
      return Promise.resolve();
    }
    const pending = readHistory();
    void setRead(pending);
    // The coordinator serializes admitted reads; the boundary presents their errors.
    return pending.then(
      () => undefined,
      () => undefined,
    );
  };
  const readHistory = async (): Promise<ChatHistoryResult | null> => {
    let previous = snapshot;
    const request = (requestCursor?: string) =>
      scope.client.request<ChatHistoryResponse>("chat.history", {
        ...scope.session,
        cursor: requestCursor,
        toolResultMaxChars: 2_000,
        limit: 20,
        maxChars: 12000,
      });
    let result = await request(cursor);
    if (!current()) {
      return null;
    }
    if ("kind" in result && result.kind === "reset") {
      // Retire the wire cursor without discarding metadata from the last successful read.
      cursor = undefined;
      previous = null;
      result = await request();
      if (!current()) {
        return null;
      }
    }
    if ("kind" in result) {
      if (result.kind === "reset") {
        throw new Error("History tail returned a reset");
      }
      let projection = createSessionProjection({}, previous?.messages ?? []);
      for (const envelope of result.messages) {
        if (!isRecord(envelope)) {
          continue;
        }
        projection = reduceSessionProjection(projection, {
          type: "messagePersisted",
          message: envelope.message,
          envelope,
        });
      }
      snapshot = { ...result, messages: projection.messages.slice(-20) };
    } else {
      snapshot = { ...result, messages: result.messages?.slice(-20) };
    }
    cursor = snapshot.deltaCursor;
    setMetadata((draft) => {
      draft.sessionInfo = snapshot?.sessionInfo;
    });
    onSettled(hydrateIdentities);
    return snapshot;
  };
  const refreshes = createSessionEventRefreshCoordinator({ active: true, refresh });
  onSettled(() => {
    const stop = scope.gateway.subscribeEvents((event) => {
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
        refreshes.schedule();
      }
    });
    refreshes.scheduleRetry(0);
    return () => {
      alive = false;
      stop();
      refreshes.dispose();
    };
  });
  const summarize = (value: ChatHistoryResult | null) =>
    (value?.messages ?? []).slice(-20).flatMap((message) => {
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
    });
  const hydrateIdentities = () => {
    if (current()) {
      void props.agentIdentity?.ensure(
        summarize(snapshot).flatMap((message) =>
          !message.sender && message.agentId ? [message.agentId] : [],
        ),
      );
    }
  };
  const identity = createMemo(() => props.agentIdentity);
  const identities = createMemo(() => {
    const source = identity();
    return source
      ? projectSource(source, {
          read: (owner) => owner,
          subscribe: (owner, notify) => {
            onSettled(hydrateIdentities);
            return owner.subscribe(() => {
              notify();
              onSettled(hydrateIdentities);
            });
          },
          equality: "revision",
        })
      : null;
  });
  function SummaryView(view: { history: ChatHistoryResult | null; unavailable?: boolean }) {
    const messages = createMemo(() => summarize(view.history));
    return (
      <>
        <section
          class="plugin-session-summary__history"
          aria-label={t("pluginUi.sessionRecentMessages")}
        >
          <h3>{t("pluginUi.sessionRecentMessages")}</h3>
          {view.unavailable ? (
            <p role="alert">{t("pluginUi.sessionHistoryUnavailable")}</p>
          ) : !view.history ? (
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
                        <ChatAuthorAvatar sender={message().sender} />
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
                    tag="div"
                    class="sidebar-markdown"
                    html={toSanitizedMarkdownHtml(message().text)}
                  />
                </article>
              )}
            </For>
          )}
        </section>
        <Show when={view.unavailable || progress.read().error}>
          <button
            class="btn"
            onClick={() => {
              refreshes.scheduleRetry(0);
              void store.load(scope.session).catch(() => undefined);
            }}
          >
            {t("common.retry")}
          </button>
        </Show>
      </>
    );
  }
  return (
    <div class="plugin-session-summary">
      <Show when={progress.read().error || progress.read().card !== null}>
        <section class="plugin-session-summary__progress">
          {progress.read().error ? (
            <p role="alert">{t("sessionProgressCard.widgetUnavailable")}</p>
          ) : progress.read().card === undefined ? (
            <p>{t("sessionProgressCard.widgetLoading")}</p>
          ) : (
            <SessionProgressCard
              card={progress.read().card}
              placement="board"
              sessionStatus={metadata.sessionInfo?.status}
              startedAt={metadata.sessionInfo?.startedAt}
              endedAt={metadata.sessionInfo?.endedAt}
              hasActiveRun={metadata.sessionInfo?.hasActiveRun === true}
            />
          )}
        </section>
      </Show>
      <Errored
        fallback={() => <SummaryView history={snapshot} unavailable={!isPending(history)} />}
      >
        <Loading fallback={<SummaryView history={snapshot} />}>
          <SummaryView history={history()} />
        </Loading>
      </Errored>
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
        {(current) => SessionHistory(props, current)}
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
