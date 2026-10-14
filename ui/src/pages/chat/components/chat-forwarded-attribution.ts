import { html, nothing } from "lit";
import "./chat-attribution.css";
import { pathForRoute } from "../../../app-route-paths.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { renderForwardedAvatar } from "../chat-avatar.ts";
import { readAutomationRun } from "../chat-turn-boundary.ts";

registerChatMessageMetadataEnglish();

type ForwardedAttributionOptions = Parameters<typeof renderForwardedAvatar>[1] & {
  mainKey?: string;
  basePath?: string;
  linkSource?: boolean;
  updateCount?: number;
  showAvatar?: boolean;
};

/**
 * Label rules (operator decision, 2026-08-30): an agent's main session reads
 * as the agent itself ("From roboclaw"); other sessions read as the session
 * name (titler-resolved), prefixed with the agent's display name only when
 * the sender is a different agent ("From democlaw · bench"). Subagent
 * sessions keep their session identity instead of presenting as another agent.
 */
export function renderForwardedAttribution(
  group: Pick<MessageGroup, "senderSession"> & Partial<Pick<MessageGroup, "messages">>,
  opts: ForwardedAttributionOptions,
) {
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
  // Only agent-prefixed keys are navigable: the titler, hovercard, and click
  // handlers all reject other shapes, so a legacy key must stay plain text
  // instead of becoming a focusable link that goes nowhere.
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
  const sourceAvatar =
    sourceIsOtherAgent && opts.updateCount === undefined && opts.showAvatar !== false
      ? renderForwardedAvatar(sourceParsed.agentId, opts)
      : nothing;
  const sourceLink =
    cronJobId && cronRunSessionId
      ? html`<a
          class="markdown-session-link markdown-session-link--titled markdown-session-link--automation"
          role="link"
          tabindex="0"
          href=${`${pathForRoute("cron", opts.basePath)}?${new URLSearchParams({ job: cronJobId, run: cronRunSessionId })}`}
          data-cron-run-link
          ><span class="session-link-icon" aria-hidden="true">${icons.clock}</span
          ><span class="session-label" .textContent=${sourceLabel}></span
        ></a>`
      : html`<a
          class="markdown-session-link${sourceLabel ? " markdown-session-link--titled" : ""}${
            sourceIsOtherAgent && sourceIsMainSession ? " markdown-session-link--agent" : ""
          }"
          role="link"
          tabindex="0"
          data-session-key=${linkableSourceKey}
          ><span class="session-label" .textContent=${sourceLabel ?? linkableSourceKey}></span
        ></a>`;
  const from =
    opts.updateCount === undefined
      ? t("chat.messages.forwardedFrom")
      : t(
          opts.updateCount === 1
            ? "chat.messages.interSessionUpdateFrom"
            : "chat.messages.interSessionUpdatesFrom",
          { count: String(opts.updateCount) },
        );
  return html`
    <span class="chat-reply-attribution chat-reply-attribution--forwarded">
      <span class="chat-reply-attribution__icon" aria-hidden="true">${icons.forward}</span>
      ${
        linkableSourceKey
          ? // The titler may replace the initial label. Its .textContent binding
            // keeps Lit text parts out of it. A group's source never changes: messages are
            // immutable and grouping splits on senderSession, so no keyed
            // remount is needed. Session sources use the titler for their href;
            // completed cron runs belong to automation history instead.
            html`<span>${from}</span>
              ${
                sourceIsOtherAgent
                  ? html`<span class="chat-reply-attribution__agent">
                        ${
                          sourceAvatar === nothing
                            ? nothing
                            : html`<span
                                class="chat-reply-attribution__agent-avatar"
                                aria-hidden="true"
                                >${sourceAvatar}</span
                              >`
                        }
                        ${sourceAgentPrefix ? html`<span>${sourceAgentPrefix}</span>` : sourceLink}
                      </span>
                      ${
                        sourceAgentPrefix
                          ? html`<span aria-hidden="true">·</span> ${sourceLink}`
                          : nothing
                      }`
                  : sourceLink
              } `
          : sourceSessionKey
            ? html`<span>${from}</span>
                ${sourceAgentPrefix ? html`<span>${sourceAgentPrefix} ·</span>` : nothing}
                <span
                  ?data-session-title-only=${Boolean(sourceParsed) && !cronJobId}
                  data-session-key=${sourceParsed && !cronJobId ? sourceSessionKey : nothing}
                  class=${sourceLabel ? "markdown-session-link--titled" : nothing}
                  ><span
                    class="session-label"
                    .textContent=${sourceLabel ?? sourceSessionKey}
                  ></span
                ></span>`
            : html`<span
                >${opts.updateCount === undefined ? nothing : t(opts.updateCount === 1 ? "chat.messages.interSessionUpdate" : "chat.messages.interSessionUpdates", { count: String(opts.updateCount) })}
                ${opts.updateCount === undefined ? nothing : " · "}${
                  group.senderSession?.agentId
                    ? t("chat.messages.forwardedFromAgent", {
                        agentId: group.senderSession.agentId,
                      })
                    : t("chat.messages.forwardedMessage")
                }</span
              >`
      }
    </span>
  `;
}
