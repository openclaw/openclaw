import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, useContext } from "solid-js";
import { webPushCompletionMessageId } from "../../../../../src/shared/web-push-completion.js";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { createIntersectionObserver } from "../../../lib/reactive/observers.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { hasTerminalRunOutcome, resolveAssistantReplyPhase } from "../chat-assistant-reply.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { TranscriptReadPresentation } from "./chat-transcript-read-presentation.ts";

/** Only the mounted answer bubble can acknowledge its delivered completion. */
export function createChatCompletionReadRef(
  message: () => unknown,
  options: () => GroupedMessageOptions,
) {
  const app = useOptionalApplication();
  const parentPresented = useContext(TranscriptReadPresentation);
  const transcriptPresented = usePanePresentation(() => options().transcriptVisible ?? false);
  const visible = createDocumentVisibility();
  const [element, setElement] = createSignal<HTMLElement>();
  let intersectingTarget: HTMLElement | undefined;
  const completion = createMemo(() => {
    const value = message();
    const identity = readSessionMessageIdentity(value);
    const opts = options();
    const metadata = asNullableRecord(asNullableRecord(value)?.["__openclaw"]);
    if (
      !app ||
      !opts.agentId ||
      !opts.sessionKey ||
      opts.isStreaming ||
      opts.isForwarded ||
      opts.searchResult ||
      metadata?.catalogTruncated === true ||
      (opts.assistantMessageDisclosure && !opts.assistantMessageDisclosure.expanded) ||
      identity?.role !== "assistant" ||
      identity.isImported ||
      !webPushCompletionMessageId(identity) ||
      !identity.runId ||
      resolveAssistantReplyPhase(value) === "commentary" ||
      !hasTerminalRunOutcome(value, identity.runId)
    ) {
      return null;
    }
    return {
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      runId: identity.runId,
      messageId: webPushCompletionMessageId(identity)!,
    };
  });
  const presented = () =>
    parentPresented() &&
    transcriptPresented() &&
    options().presented === true &&
    visible() &&
    document.visibilityState === "visible";
  createIntersectionObserver(
    () => {
      const target = element();
      // Read completion reactively so a recycled/updated bubble gets a fresh observation.
      return target && presented() && completion() ? [target] : [];
    },
    (entries) => {
      const target = element();
      const identity = completion();
      const entry = entries.findLast((candidate) => candidate.target === target);
      if (!entry) {
        return;
      }
      intersectingTarget =
        entry.isIntersecting &&
        entry.intersectionRect.width > 0 &&
        entry.intersectionRect.height > 0
          ? target
          : undefined;
      if (
        !identity ||
        !target ||
        !target.isConnected ||
        !presented() ||
        intersectingTarget !== target
      ) {
        return;
      }
      app?.webPush.viewed(
        identity,
        () =>
          presented() &&
          target.isConnected &&
          element() === target &&
          intersectingTarget === target &&
          completion() === identity,
      );
    },
  );
  return elementRef((target: HTMLElement) => {
    setElement(target);
    return () => setElement(undefined);
  });
}
