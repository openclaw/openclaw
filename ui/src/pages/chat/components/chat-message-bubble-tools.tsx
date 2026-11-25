import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, lazy, merge, Show } from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolContentEnglish } from "../../../i18n/locales/en-chat-tool-content.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { PluginSurface } from "../../../plugins/control-ui-view.solid.tsx";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";
import { ActivityOperation } from "./chat-message-activity-operation.tsx";
import { OmittedMedia } from "./chat-message-attachment-status-solid.tsx";
import type { ActivityOperationProps } from "./chat-message-bubble-options.ts";
import type { MessageContentProps as ContentProps } from "./chat-message-bubble-presentation.ts";
import {
  ChatPermissionCard,
  ExpandedToolCardContent,
  ToolPreview,
} from "./chat-message-deferred.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";
import type { ToolCardOptions } from "./chat-tool-card-types.ts";
import { ChatToolCard, ToolApprovalReviews } from "./chat-tool-cards.solid.tsx";
import { toolResultSurfaceProps } from "./chat-tool-render-model.ts";

registerEnglishCatalog(registerChatToolContentEnglish);

const ToolMessageSummary = lazy(() => import("./chat-tool-card-row.solid.tsx"), {
  export: "ToolMessageSummary",
});

type ToolMessageProps = ContentProps & {
  renderContents: () => JSX.Element;
};

export function InlineToolCards(props: {
  cards: ToolCard[];
  options: Omit<ToolCardOptions, "expanded" | "onToggleExpanded"> & {
    isToolExpanded?: (id: string, card?: ToolCard) => boolean;
    onToggleToolExpanded?: (id: string, expanded?: boolean) => void;
    toolCardOverrides?: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
  };
}) {
  return (
    <div class="chat-tools-inline">
      <For each={props.cards} keyed={(card) => card.callId ?? card}>
        {(card, index) => {
          const disclosureId = () => `${props.options.messageKey}:toolcard:${index()}`;
          const expanded = createMemo(
            () => props.options.isToolExpanded?.(disclosureId(), card()) ?? false,
          );
          const options = merge(() => props.options, {
            get expanded() {
              return expanded();
            },
            onToggleExpanded: () =>
              props.options.onToggleToolExpanded?.(disclosureId(), expanded()),
          });
          return (
            <Show
              when={props.options.toolCardOverrides?.has(card())}
              fallback={<ChatToolCard card={card()} options={options} />}
            >
              <Show when={props.options.toolCardOverrides?.get(card())}>
                {(operation) => <ActivityOperation {...operation()} />}
              </Show>
            </Show>
          );
        }}
      </For>
    </div>
  );
}

export function AssistantViews(props: ContentProps) {
  const messageTimestamp = () => {
    const value = props.state().m.timestamp;
    return typeof value === "number" ? value : undefined;
  };
  return (
    <Show when={props.state().sourceRole === "assistant"}>
      <For each={props.state().assistantViewBlocks} keyed={false}>
        {(block) => {
          return (
            <div class="chat-tool-card__widget-host">
              <ToolPreview
                preview={block().preview}
                surface="chat_message"
                options={{
                  rawText: block().rawText ?? null,
                  canvasPluginSurfaceUrl: props.options.canvasPluginSurfaceUrl,
                  mediaReadAllowed: props.options.mediaReadAllowed,
                  boardProvider: props.options.boardProvider,
                  widgetLayout: props.options.widgetLayout,
                  embedSandboxMode: props.options.embedSandboxMode ?? "scripts",
                  allowExternalEmbedUrls: props.options.allowExternalEmbedUrls,
                  sessionKey: props.options.sessionKey,
                  messageTimestamp: messageTimestamp(),
                }}
              />
            </div>
          );
        }}
      </For>
    </Show>
  );
}

export function BubbleToolCards(props: ContentProps) {
  const options = merge(() => props.state().toolRenderOptions, {
    get showApprovalReviews() {
      return props.state().isStandaloneToolMessage ? false : undefined;
    },
  });
  return (
    <>
      <Show when={props.state().hasToolCards}>
        <Show
          when={
            props.state().isStandaloneToolMessage &&
            props.state().expandsSingleToolCard &&
            props.state().singleToolCard
          }
          fallback={<InlineToolCards cards={props.state().toolCards} options={options} />}
        >
          <openclaw-chat-tool-content style={{ display: "contents" }}>
            <ExpandedToolCardContent
              card={props.state().singleToolCard!}
              options={props.state().toolRenderOptions}
            />
          </openclaw-chat-tool-content>
        </Show>
      </Show>
      <Show when={props.state().isStandaloneToolMessage && props.state().failedToolCard}>
        <openclaw-chat-tool-outcome style={{ display: "contents" }}>
          <div class="chat-tool-card__outcome">
            {props.state().failedToolCard!.exitCode !== undefined &&
            props.state().failedToolCard!.exitCode !== 0
              ? t("chat.toolCards.exitCode", {
                  code: String(props.state().failedToolCard!.exitCode),
                })
              : t("chat.toolCards.failed")}
          </div>
        </openclaw-chat-tool-outcome>
      </Show>
    </>
  );
}

function ToolMessageFallback(props: ToolMessageProps) {
  const identity = () => {
    const card = props.state().singleToolCard;
    return card ? resolveToolDisplayIdentity(unwrapToolCallForDisplay(card).name) : null;
  };
  const inspectedImage = () => {
    const card = props.state().singleToolCard;
    return card &&
      unwrapToolCallForDisplay(card).name === "view_image" &&
      resolveToolCardOutcome(card, props.options.runActive) === "succeeded" &&
      props.state().images.length > 0
      ? card
      : null;
  };
  let host: HTMLDivElement | undefined;
  return (
    <div
      ref={(element) => (host = element)}
      class={[
        "chat-tool-msg-collapse chat-tool-msg-collapse--manual",
        { "is-open": props.state().toolMessageExpanded },
      ]}
    >
      <ChatImportBoundary
        identity={[props.options.sessionKey, props.messageKey]}
        connected={() => Boolean(host?.isConnected)}
        fallback={() => (
          <button
            class="chat-inline-disclosure chat-tool-msg-summary"
            type="button"
            disabled
            aria-busy="true"
          >
            <span class="chat-tool-msg-summary__icon">
              <Show when={identity()} fallback={<Icon name="zap" />}>
                {(display) => (
                  <ChatToolIcon
                    name={display().icon}
                    tool={{
                      toolName: display().name,
                      pluginToolIcons: props.options.pluginToolIcons,
                    }}
                    style={{ display: "contents" }}
                  />
                )}
              </Show>
            </span>
            <span class="chat-tool-disclosure__content">
              <span class="chat-tool-msg-summary__label">
                {identity() && !props.state().markdown && props.state().images.length === 0
                  ? identity()!.label
                  : t("chat.toolCards.toolOutput")}
              </span>
            </span>
            <span class="chat-tool-row__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </button>
        )}
      >
        <ToolMessageSummary state={props.state()} options={props.options} />
      </ChatImportBoundary>
      <Show
        when={props.state().toolMessageExpanded}
        fallback={<OmittedMedia items={props.state().omittedMedia} />}
      >
        <Show
          when={inspectedImage()}
          fallback={<div class="chat-tool-msg-body">{props.renderContents()}</div>}
        >
          {(card) => (
            <>
              <div class="row chat-inspection">
                <MessageImages
                  images={props.state().images}
                  options={props.state().imageRenderOptions}
                  previewBounds={{ width: 200, height: 140 }}
                />
                <Show when={props.state().toolRenderOptions.onOpenSidebar}>
                  <span class="chat-tool-card__actions">
                    <button
                      class="chat-tool-card__action-btn"
                      type="button"
                      title={t("chat.toolCards.openDetailsTooltip")}
                      aria-label={t("chat.toolCards.openDetails")}
                      onClick={() =>
                        props.state().toolRenderOptions.onOpenSidebar?.({
                          kind: "tool-output",
                          card: card(),
                          sessionKey: props.options.sessionKey,
                          agentId: props.options.agentId,
                        })
                      }
                    >
                      <span class="chat-tool-card__action-icon">
                        <Icon name="panelRightOpen" />
                      </span>
                    </button>
                  </span>
                </Show>
              </div>
              <Show when={!props.state().toolRenderOptions.onOpenSidebar}>
                <details class="chat-tool-wrapper-details">
                  <summary>{t("chat.toolCards.openDetailsTooltip")}</summary>
                  <ExpandedToolCardContent
                    card={card()}
                    options={props.state().toolRenderOptions}
                  />
                </details>
              </Show>
              <OmittedMedia items={props.state().omittedMedia} />
            </>
          )}
        </Show>
      </Show>
      <For each={props.state().toolCards} keyed={(card) => card.callId ?? card}>
        {(card) => (
          <openclaw-chat-tool-reviews style={{ display: "contents" }}>
            <ToolApprovalReviews card={card()} />
          </openclaw-chat-tool-reviews>
        )}
      </For>
    </div>
  );
}

export function ToolMessage(props: ToolMessageProps) {
  const permission = () =>
    readNodePermissionRequest(
      asNullableRecord(props.state().singleToolCard?.details)?.permissionMissing,
    );
  return (
    <Show
      when={permission()}
      fallback={
        <Show when={props.state().singleToolCard} fallback={<ToolMessageFallback {...props} />}>
          {(card) => (
            <PluginSurface
              surface="tool-result"
              props={toolResultSurfaceProps(card(), {
                ...props.state().toolRenderOptions,
                expanded: props.state().toolMessageExpanded,
              })}
              presented={props.options.presented ?? true}
              enabled={props.options.mediaReadAllowed !== false}
              renderDefault={() => <ToolMessageFallback {...props} />}
            />
          )}
        </Show>
      }
    >
      {(request) => (
        <ChatPermissionCard request={request()} onRetry={props.options.onPermissionRetry} />
      )}
    </Show>
  );
}
