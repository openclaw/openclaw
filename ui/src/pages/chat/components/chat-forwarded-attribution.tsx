import { createMemo, Show } from "solid-js";
import "./chat-attribution.css";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { ForwardedAvatar, type ForwardedAvatarOptions } from "../chat-avatar-view.tsx";
import { readAutomationRun } from "../chat-turn-boundary.ts";

registerChatMessageMetadataEnglish();

export type ForwardedAttributionOptions = ForwardedAvatarOptions & {
  mainKey?: string;
  basePath?: string;
  linkSource?: boolean;
  updateCount?: number;
};

type ForwardedGroup = Pick<MessageGroup, "senderSession"> & Partial<Pick<MessageGroup, "messages">>;

/** Main sessions name their agent; other-agent sessions prefix the session name. */
function forwardedSource(group: ForwardedGroup, opts: ForwardedAttributionOptions) {
  const sourceSessionKey = group.senderSession?.sessionKey;
  const sourceParsed = sourceSessionKey ? parseAgentSessionKey(sourceSessionKey) : null;
  const sourceCronRun = /^cron:([^:]+):run:([^:]+)$/u.exec(sourceParsed?.rest ?? "");
  // Session-bound jobs use a conversation key; the recorded run owns navigation.
  const automation = readAutomationRun(group.messages?.[0]?.message);
  const cronJobId = automation?.jobId ?? sourceCronRun?.[1];
  const cronRunSessionId = automation?.runId ?? sourceCronRun?.[2];
  const sourceIsSubagent = isSubagentSessionKey(sourceSessionKey);
  const sourceIsOtherAgent =
    !sourceIsSubagent &&
    sourceParsed &&
    Boolean(opts.agentId) &&
    sourceParsed.agentId !== opts.agentId;
  // Only agent-prefixed keys are navigable; legacy keys stay plain text.
  const linkableSourceKey =
    opts.linkSource !== false && sourceParsed ? sourceSessionKey : undefined;
  const sourceAgentDisplayName = sourceParsed
    ? opts.agents?.find((agent) => agent.id === sourceParsed.agentId)?.identity?.name?.trim() ||
      sourceParsed.agentId
    : undefined;
  const sourceIsMainSession = Boolean(
    sourceParsed && opts.mainKey && sourceParsed.rest === opts.mainKey,
  );
  const sourceLabel =
    group.senderSession?.label ??
    (cronJobId
      ? t("chat.messages.forwardedAutomation")
      : sourceIsMainSession
        ? sourceAgentDisplayName
        : undefined);
  const sourceAgentPrefix =
    !sourceIsMainSession && sourceIsOtherAgent ? sourceAgentDisplayName : undefined;
  return {
    sourceSessionKey,
    sourceParsed,
    cronJobId,
    cronRunSessionId,
    sourceIsOtherAgent,
    linkableSourceKey,
    sourceIsMainSession,
    sourceLabel,
    sourceAgentPrefix,
  };
}

type ForwardedSource = ReturnType<typeof forwardedSource>;

function ForwardedLink(props: { source: ForwardedSource; basePath?: string }) {
  // The titler owns later label/href writes. Equal initial labels must not erase them.
  const initialLabel = createMemo(
    () => props.source.sourceLabel ?? props.source.linkableSourceKey ?? "",
  );
  return (
    <Show
      when={props.source.cronJobId && props.source.cronRunSessionId}
      fallback={
        <a
          class={[
            "markdown-session-link",
            {
              "markdown-session-link--titled": Boolean(props.source.sourceLabel),
              "markdown-session-link--agent": Boolean(
                props.source.sourceIsOtherAgent && props.source.sourceIsMainSession,
              ),
            },
          ]}
          role="link"
          tabindex="0"
          data-session-key={props.source.linkableSourceKey}
        >
          <span class="session-label" textContent={initialLabel()} />
        </a>
      }
    >
      <a
        class="markdown-session-link markdown-session-link--titled markdown-session-link--automation"
        role="link"
        tabindex="0"
        href={`${pathForRoute("cron", props.basePath)}?${new URLSearchParams({ job: props.source.cronJobId!, run: props.source.cronRunSessionId! })}`}
        data-cron-run-link=""
      >
        <span class="session-link-icon" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <span class="session-label" textContent={initialLabel()} />
      </a>
    </Show>
  );
}

export function ForwardedAttribution(props: {
  group: ForwardedGroup;
  options: ForwardedAttributionOptions;
}) {
  const source = createMemo(() => forwardedSource(props.group, props.options));
  const initialPlainLabel = createMemo(
    () => source().sourceLabel ?? source().sourceSessionKey ?? "",
  );
  const avatarAgentId = () =>
    source().sourceIsOtherAgent && props.options.updateCount === undefined
      ? source().sourceParsed?.agentId
      : undefined;
  const hasAvatar = () => {
    const agentId = avatarAgentId();
    return Boolean(
      agentId &&
      (agentId === props.options.agentId ||
        props.options.agents?.some((agent) => agent.id === agentId)),
    );
  };
  const from = () =>
    props.options.updateCount === undefined
      ? t("chat.messages.forwardedFrom")
      : t(
          props.options.updateCount === 1
            ? "chat.messages.interSessionUpdateFrom"
            : "chat.messages.interSessionUpdatesFrom",
          { count: String(props.options.updateCount) },
        );
  return (
    <span class="chat-reply-attribution chat-reply-attribution--forwarded">
      <span class="chat-reply-attribution__icon" aria-hidden="true">
        <Icon name="forward" />
      </span>{" "}
      <Show
        when={source().linkableSourceKey}
        fallback={
          <Show
            when={source().sourceSessionKey}
            fallback={
              <span>
                {props.options.updateCount === undefined
                  ? undefined
                  : t(
                      props.options.updateCount === 1
                        ? "chat.messages.interSessionUpdate"
                        : "chat.messages.interSessionUpdates",
                      { count: String(props.options.updateCount) },
                    )}
                {props.options.updateCount === undefined ? undefined : " · "}
                {props.group.senderSession?.agentId
                  ? t("chat.messages.forwardedFromAgent", {
                      agentId: props.group.senderSession.agentId,
                    })
                  : t("chat.messages.forwardedMessage")}
              </span>
            }
          >
            <span>{from()}</span>{" "}
            <Show when={source().sourceAgentPrefix}>
              {(prefix) => (
                <>
                  <span>{prefix()} ·</span>{" "}
                </>
              )}
            </Show>
            <span
              data-session-title-only={
                source().sourceParsed && !source().cronJobId ? "" : undefined
              }
              data-session-key={
                source().sourceParsed && !source().cronJobId ? source().sourceSessionKey : undefined
              }
              class={{ "markdown-session-link--titled": Boolean(source().sourceLabel) }}
            >
              <span class="session-label" textContent={initialPlainLabel()} />
            </span>
          </Show>
        }
      >
        <span>{from()}</span>{" "}
        <Show
          when={source().sourceIsOtherAgent}
          fallback={<ForwardedLink source={source()} basePath={props.options.basePath} />}
        >
          <span class="chat-reply-attribution__agent">
            <Show when={hasAvatar()}>
              <span class="chat-reply-attribution__agent-avatar" aria-hidden="true">
                <ForwardedAvatar agentId={avatarAgentId()} options={props.options} />
              </span>
            </Show>
            <Show
              when={source().sourceAgentPrefix}
              fallback={<ForwardedLink source={source()} basePath={props.options.basePath} />}
            >
              {(prefix) => <span>{prefix()}</span>}
            </Show>
          </span>
          <Show when={source().sourceAgentPrefix}>
            {" "}
            <span aria-hidden="true">·</span>{" "}
            <ForwardedLink source={source()} basePath={props.options.basePath} />
          </Show>
        </Show>
      </Show>
    </span>
  );
}
