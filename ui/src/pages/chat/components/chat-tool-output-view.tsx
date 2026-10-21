import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { CHAT_MESSAGE_MAX_CHARS } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import {
  isLegacyToolOutputUnavailable,
  toolOutputSourceLabel,
  formatToolOutput,
} from "../../../lib/chat/tool-output.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { JSX } from "../../../types/solid-elements.d.ts";
import type {
  SidebarFullMessageLoader,
  ToolOutputSidebarContent,
} from "./chat-sidebar-content-types.ts";
import { RawOutputToggle } from "./chat-tool-content.solid.tsx";

type OutputLoadState = "idle" | "loading" | "loaded" | "unavailable" | "error";
type OutputResult = { state: OutputLoadState; card: ToolCard | null };
type Props = {
  content?: ToolOutputSidebarContent | null;
  loadFullMessage?: SidebarFullMessageLoader | null;
  connectionEpoch?: number;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
};

export function ChatToolOutput(props: Props) {
  const [retry, setRetry] = createSignal(0);
  const target = createMemo(() => ({
    content: props.content,
    epoch: props.connectionEpoch,
    loader: props.loadFullMessage,
    retry: retry(),
  }));
  const [output, setOutput] = createSignal<OutputResult>({ state: "idle", card: null });
  function RequestLifetime(resource: { target: ReturnType<typeof target> }) {
    onSettled(() => {
      const { content, loader } = resource.target;
      if (!content) {
        setOutput({ state: "idle", card: null });
        return undefined;
      }
      const { card, sessionKey, agentId } = content;
      if (isLegacyToolOutputUnavailable(card)) {
        setOutput({ state: "unavailable", card: null });
        return undefined;
      }
      const messageId = card.resultMessageId;
      if (!sessionKey || !messageId || !card.callId || !loader) {
        setOutput({ state: card.outputTruncated ? "unavailable" : "idle", card: null });
        return undefined;
      }
      let active = true;
      setOutput({ state: "loading", card: null });
      void (async () => {
        try {
          const result = await loader({
            sessionKey,
            agentId,
            messageId,
            maxChars: card.outputTruncated ? CHAT_MESSAGE_MAX_CHARS : 2_000_000,
          });
          if (!active) {
            return;
          }
          const matches =
            result?.ok && result.message
              ? extractToolCardsCached(result.message).filter(
                  (item) => item.callId === card.callId && item.completed,
                )
              : [];
          const loadedCard = matches.length === 1 ? matches[0] : undefined;
          if (!loadedCard || loadedCard.outputText === undefined) {
            setOutput({ state: "unavailable", card: null });
            return;
          }
          setOutput({
            card: { ...card, ...loadedCard },
            state:
              loadedCard.outputTruncated || isLegacyToolOutputUnavailable(loadedCard)
                ? "unavailable"
                : "loaded",
          });
        } catch {
          if (active) {
            setOutput({ state: "error", card: null });
          }
        }
      })();
      return () => {
        active = false;
      };
    });
    return null;
  }
  const loadState = () => output().state;
  const [downloadFailed, setDownloadFailed] = createSignal(() => {
    target();
    return false;
  });

  function downloadOutput(card: ToolCard) {
    setDownloadFailed(false);
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([card.outputText ?? ""], { type: "text/plain;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tool-output.txt";
      anchor.click();
    } catch {
      setDownloadFailed(true);
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  }
  const card = () => output().card ?? props.content?.card;
  const text = () => card()?.outputText ?? "";
  const displayText = () => (card() ? (formatToolOutput(card()!) ?? "") : "");
  return (
    <openclaw-chat-tool-output class={props.class}>
      <Show when={target()} keyed>
        {(current) => <RequestLifetime target={current} />}
      </Show>
      <Show when={card()}>
        <section class="chat-tool-output" aria-busy={loadState() === "loading" ? "true" : "false"}>
          <div class="sidebar-header">
            <div class="sidebar-title">{toolOutputSourceLabel(card()!)}</div>
          </div>
          <Show when={loadState() === "loading"}>
            <p role="status">{t("common.loading")}</p>
          </Show>
          <Show when={loadState() === "unavailable"}>
            <p role="status">{t("chat.toolCards.fullOutputUnavailable")}</p>
          </Show>
          <Show when={loadState() === "error"}>
            <p role="alert">
              {t("chat.toolCards.outputLoadFailed")}{" "}
              <button class="btn btn--sm" onClick={() => setRetry((value) => value + 1)}>
                {t("common.retry")}
              </button>
            </p>
          </Show>
          <Show when={card()!.inputText !== undefined}>
            <details>
              <summary>{t("chat.toolCards.toolInput")}</summary>
              <pre>{card()!.inputText}</pre>
            </details>
          </Show>
          <Show when={loadState() !== "loading"}>
            <div class="chat-tool-output__actions">
              <CopyButton text={text()} idleLabel={t("chat.toolCards.copyOutput")} />
              <button class="btn btn--sm" type="button" onClick={() => downloadOutput(card()!)}>
                {t("chat.toolCards.downloadOutput")}
              </button>
            </div>
          </Show>
          <Show when={downloadFailed()}>
            <p role="alert">{t("chat.toolCards.outputDownloadFailed")}</p>
          </Show>
          <pre class="chat-tool-output__text">
            <code>{displayText()}</code>
          </pre>
          <Show when={displayText() !== text()}>
            <RawOutputToggle text={text()} />
          </Show>
        </section>
      </Show>
    </openclaw-chat-tool-output>
  );
}
