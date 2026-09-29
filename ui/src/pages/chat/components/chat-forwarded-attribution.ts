// Attribution row for forwarded agent and automation messages.
import { html, nothing } from "lit";
import "./chat-attribution.css";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { renderForwardedAvatar } from "../chat-avatar.ts";

registerChatMessageMetadataEnglish();

type ForwardedAttributionOptions = Parameters<typeof renderForwardedAvatar>[1] & {
  mainKey?: string;
  linkSource?: boolean;
};

/**
 * Label rules (operator decision, 2026-08-30): an agent's main session reads
 * as the agent itself ("From roboclaw"); other sessions read as the session
 * name (titler-resolved), prefixed with the agent's display name only when
 * the sender is a different agent ("From democlaw · bench"). Subagent
 * sessions keep their session identity instead of presenting as another agent.
 */
export function renderForwardedAttribution(
  group: Pick<MessageGroup, "senderSession">,
  opts: ForwardedAttributionOptions,
) {
  const sourceSessionKey = group.senderSession?.sessionKey;
  const sourceParsed = sourceSessionKey ? parseAgentSessionKey(sourceSessionKey) : null;
  const sourceIsCronRun = /^cron:[^:]+:run:[^:]+$/u.test(sourceParsed?.rest ?? "");
  const sourceIsSubagent = isSubagentSessionKey(sourceSessionKey);
  const sourceIsOtherAgent =
    !sourceIsSubagent && sourceParsed && sourceParsed.agentId !== opts.agentId;
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
    (sourceIsCronRun
      ? t("chat.messages.forwardedAutomation")
      : sourceIsMainSession
        ? sourceAgentDisplayName
        : undefined);
  const sourceAgentPrefix =
    !sourceIsMainSession && sourceIsOtherAgent ? sourceAgentDisplayName : undefined;
  const sourceAvatar = sourceIsOtherAgent
    ? renderForwardedAvatar(sourceParsed.agentId, opts)
    : nothing;
  const sourceLink = sourceIsCronRun
    ? html`<a
        class="markdown-session-link markdown-session-link--titled markdown-session-link--automation"
        role="link"
        tabindex="0"
        data-session-key=${linkableSourceKey}
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
  return html`
    <div class="chat-reply-attribution chat-reply-attribution--forwarded">
      <span class="chat-reply-attribution__icon" aria-hidden="true">${icons.forward}</span>
      ${
        linkableSourceKey
          ? // The titler may replace the initial label. Its .textContent binding
            // keeps Lit text parts out of it. A group's source never changes: messages are
            // immutable and grouping splits on senderSession, so no keyed
            // remount is needed. Gateway labels, cron fallbacks, and main-session
            // agent names pre-title the source; the titler still stamps the href.
            html`<span>${t("chat.messages.forwardedFrom")}</span>
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
            ? html`<span>${t("chat.messages.forwardedFrom")}</span>
                <span>${sourceLabel ?? sourceSessionKey}</span>`
            : html`<span
                >${
                  group.senderSession?.agentId
                    ? t("chat.messages.forwardedFromAgent", {
                        agentId: group.senderSession.agentId,
                      })
                    : t("chat.messages.forwardedMessage")
                }</span
              >`
      }
    </div>
  `;
}
