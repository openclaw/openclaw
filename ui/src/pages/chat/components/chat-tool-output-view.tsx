import { createEffect, createSignal, onCleanup, runWithOwner, Show } from "solid-js";
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
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import type {
  SidebarFullMessageLoader,
  ToolOutputSidebarContent,
} from "./chat-sidebar-content-types.ts";
import { RawOutputToggle } from "./chat-tool-content.solid.tsx";

type OutputLoadState = "idle" | "loading" | "loaded" | "unavailable" | "error";
type Props = {
  content: ToolOutputSidebarContent | null;
  loadFullMessage: SidebarFullMessageLoader | null;
  connectionEpoch: number | undefined;
};

function ToolOutput(props: Props) {
  const [resolved, setResolved] = createSignal<ToolCard | null>(null);
  const [loadState, setLoadState] = createSignal<OutputLoadState>("idle");
  const [downloadFailed, setDownloadFailed] = createSignal(false);
  let requestVersion = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    requestVersion += 1;
  });

  async function loadOutput(
    content: Props["content"],
    epoch: Props["connectionEpoch"],
    loader: Props["loadFullMessage"],
  ) {
    const version = ++requestVersion;
    const current = () =>
      !disposed &&
      version === requestVersion &&
      props.content === content &&
      props.connectionEpoch === epoch &&
      props.loadFullMessage === loader;
    setResolved(null);
    setLoadState("idle");
    setDownloadFailed(false);
    if (!content) {
      return;
    }
    const { card, sessionKey, agentId } = content;
    if (isLegacyToolOutputUnavailable(card)) {
      setLoadState("unavailable");
      return;
    }
    if (!sessionKey || !card.resultMessageId || !card.callId || !loader) {
      if (card.outputTruncated) {
        setLoadState("unavailable");
      }
      return;
    }
    setLoadState("loading");
    try {
      const result = await loader({
        sessionKey,
        agentId,
        messageId: card.resultMessageId,
        maxChars: card.outputTruncated ? CHAT_MESSAGE_MAX_CHARS : 2_000_000,
      });
      if (!current()) {
        return;
      }
      const matches =
        result?.ok && result.message
          ? extractToolCardsCached(result.message).filter(
              (item) => item.callId === card.callId && item.completed,
            )
          : [];
      const output = matches.length === 1 ? matches[0] : undefined;
      if (!output || output.outputText === undefined) {
        setLoadState("unavailable");
        return;
      }
      setResolved({ ...card, ...output });
      setLoadState(
        output.outputTruncated || isLegacyToolOutputUnavailable(output) ? "unavailable" : "loaded",
      );
    } catch {
      if (current()) {
        setLoadState("error");
      }
    }
  }
  createEffect(
    () => [props.content, props.connectionEpoch, props.loadFullMessage] as const,
    (values) => {
      // A nested bridge may flush while its parent is still rendering.
      runWithOwner(null, () => void loadOutput(...values));
    },
  );

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
  const card = () => resolved() ?? props.content?.card;
  const text = () => card()?.outputText ?? "";
  const displayText = () => (card() ? (formatToolOutput(card()!) ?? "") : "");
  return (
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
            <button
              class="btn btn--sm"
              onClick={() =>
                void loadOutput(props.content, props.connectionEpoch, props.loadFullMessage)
              }
            >
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
  );
}

export const ChatToolOutput = defineSolidBridge<Props>("openclaw-chat-tool-output", ToolOutput, {
  properties: {
    content: { default: null, attribute: false },
    loadFullMessage: { default: null, attribute: false },
    connectionEpoch: { default: undefined, type: Number },
  },
});
