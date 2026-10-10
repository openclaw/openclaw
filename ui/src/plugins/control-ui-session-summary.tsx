import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX as SolidJSX } from "@solidjs/web";
import { nothing, render, type TemplateResult } from "lit";
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
import type { AgentAvatar as AgentAvatarElement } from "../components/agent-avatar.ts";
import "../components/agent-avatar.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { renderSessionProgressCard } from "../components/session-progress-card.ts";
import { Icon } from "../components/solid/icon.tsx";
import { SanitizedHtml } from "../components/solid/sanitized-html.tsx";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import { extractText } from "../lib/chat/message-extract.ts";
import { normalizeMessage } from "../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../lib/chat/sender-label.ts";
import { projectGateway, projectGatewayEvents } from "../lib/reactive/application.ts";
import { projectAgentIdentity } from "../lib/reactive/domain-capabilities.ts";
import { projectProgressCard } from "../lib/reactive/domain-keyed.ts";
import { t } from "../lib/reactive/i18n.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { readSessionChangedEvent } from "../lib/sessions/reconcile.ts";
import { uiSessionEventMatches, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
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

// The shared progress and sender-avatar helpers remain Lit-owned until their callers migrate.
function LitContent(props: { content: TemplateResult | typeof nothing }) {
  const host = document.createElement("span");
  host.style.display = "contents";
  let part: ReturnType<typeof render> | undefined;
  createEffect(
    () => props.content,
    (content) => {
      part = render(content, host);
    },
  );
  onCleanup(() => {
    part?.setConnected(false);
    render(nothing, host);
  });
  return host;
}

function AgentAvatar(props: {
  agentId: string;
  label: string;
  agent: AgentsListResult["agents"][number] | undefined;
  identity: AgentIdentityCapability | null;
}) {
  const projection = createMemo(() =>
    props.identity
      ? projectAgentIdentity({ identities: props.identity, agentId: props.agentId })
      : null,
  );
  createEffect(
    () => {
      projection()?.read();
      return { identity: props.identity, agentId: props.agentId };
    },
    (current) => {
      void current.identity?.ensure([current.agentId]);
    },
  );
  return (
    <openclaw-agent-avatar
      prop:option={{
        value: props.agentId,
        label: props.label,
        agent: props.agent ?? { id: props.agentId },
      }}
      prop:identity={projection()?.read() ?? null}
    />
  );
}

type SummaryScope = {
  gateway: ApplicationGateway;
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>;
  revision: number;
  session: BoardGetParams;
};

function SessionHistory(props: PluginSessionSummaryProps & { scope: SummaryScope }) {
  const scope = untrack(() => props.scope);
  const [history, setHistory] = createSignal<ChatHistoryResult | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  let alive = true;
  let pending = false;
  let dirty = false;
  const current = () =>
    untrack(
      () =>
        alive &&
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
  const refresh = () => {
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
    void scope.client
      .request<ChatHistoryResult>("chat.history", {
        ...scope.session,
        toolResultMaxChars: 2_000,
        limit: 20,
        maxChars: 12000,
      })
      .then((result) => {
        if (current()) {
          setHistory(result);
        }
      })
      .catch(() => {
        if (current()) {
          setError(true);
        }
      })
      .finally(() => {
        if (!current()) {
          return;
        }
        pending = false;
        setLoading(false);
        if (dirty) {
          refresh();
        }
      });
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
        refresh();
      }
    }),
  );
  onSettled(() => {
    refresh();
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
  return (
    <div class="plugin-session-summary">
      <Show
        when={progress.read().error || progress.read().card === undefined || progress.read().card}
      >
        <section class="plugin-session-summary__progress">
          <Show
            when={!progress.read().error}
            fallback={<p role="alert">{t("sessionProgressCard.widgetUnavailable")}</p>}
          >
            <Show
              when={progress.read().card !== undefined}
              fallback={<p>{t("sessionProgressCard.widgetLoading")}</p>}
            >
              <LitContent
                content={renderSessionProgressCard(
                  progress.read().card,
                  "board",
                  undefined,
                  history()?.sessionInfo?.status,
                  history()?.sessionInfo?.startedAt,
                  history()?.sessionInfo?.endedAt,
                  history()?.sessionInfo?.hasActiveRun === true,
                )}
              />
            </Show>
          </Show>
        </section>
      </Show>
      <section
        class="plugin-session-summary__history"
        aria-label={t("pluginUi.sessionRecentMessages")}
      >
        <h3>{t("pluginUi.sessionRecentMessages")}</h3>
        <Show when={!loading() && (history() || error())} fallback={<p>{t("common.loading")}</p>}>
          <Show
            when={!error()}
            fallback={<p role="alert">{t("pluginUi.sessionHistoryUnavailable")}</p>}
          >
            <For
              keyed={false}
              each={messages()}
              fallback={<p>{t("pluginUi.sessionHistoryEmpty")}</p>}
            >
              {(message) => (
                <article class="plugin-session-summary__message">
                  <header class="plugin-session-summary__message-header">
                    <span class="plugin-session-summary__avatar">
                      <Show
                        when={message().sender}
                        fallback={
                          <Show
                            when={message().agentId}
                            fallback={
                              <span class="plugin-session-summary__unknown" aria-hidden="true">
                                <Icon name={message().role === "user" ? "users" : "bot"} />
                              </span>
                            }
                          >
                            {(agentId) => (
                              <AgentAvatar
                                agentId={agentId()}
                                label={message().label}
                                agent={message().agent}
                                identity={props.agentIdentity}
                              />
                            )}
                          </Show>
                        }
                      >
                        {(sender) => <LitContent content={renderChatAuthorAvatar(sender())} />}
                      </Show>
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
          </Show>
        </Show>
      </section>
      <Show when={error() || progress.read().error}>
        <button
          class="btn"
          onClick={() => {
            refresh();
            void store.load(scope.session).catch(() => undefined);
          }}
        >
          {t("common.retry")}
        </button>
      </Show>
    </div>
  );
}

function PresentedSummary(
  props: PluginSessionSummaryProps & { activeGateway: ApplicationGateway },
) {
  const gateway = createMemo(() => projectGateway(props.activeGateway));
  const scope = createMemo<SummaryScope | null>(
    () => {
      const state = gateway().read();
      return state.snapshot.phase === "connected" && state.snapshot.client && props.session
        ? {
            gateway: props.activeGateway,
            client: state.snapshot.client,
            revision: state.connectionRevision,
            session: { ...props.session },
          }
        : null;
    },
    {
      equals: (left, right) =>
        left?.gateway === right?.gateway &&
        left?.client === right?.client &&
        left?.revision === right?.revision &&
        left?.session.sessionKey === right?.session.sessionKey &&
        left?.session.agentId === right?.session.agentId,
    },
  );
  return (
    <Show
      when={scope()}
      keyed
      fallback={<p role="status">{t("pluginUi.sessionHistoryUnavailable")}</p>}
    >
      {(current) => <SessionHistory {...props} scope={current} />}
    </Show>
  );
}

function PluginSessionSummaryContent(props: PluginSessionSummaryProps) {
  return (
    <Show when={props.presented}>
      <Show
        when={props.gateway}
        keyed
        fallback={<p role="status">{t("pluginUi.sessionHistoryUnavailable")}</p>}
      >
        {(gateway) => <PresentedSummary {...props} activeGateway={gateway} />}
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

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-avatar": SolidJSX.HTMLAttributes<AgentAvatarElement> & {
        "prop:option"?: AgentAvatarElement["option"];
        "prop:identity"?: AgentAvatarElement["identity"];
      };
    }
  }
}
