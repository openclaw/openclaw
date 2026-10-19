import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createStore, onCleanup } from "solid-js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../../api/gateway.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";

export type ComposerPredictionSource = {
  gateway: Pick<ApplicationGateway, "subscribeEvents">;
  client: GatewayBrowserClient;
  sessionKey: string;
  sessionId: string | null;
  enabled: boolean;
  eligible: boolean;
  idle: boolean;
};

/** An unaccepted prediction is presentation only, never a draft or queued message. */
export function createComposerPrediction(read: () => ComposerPredictionSource | null) {
  const [state, setState] = createStore<{ text: string | null }>({ text: null });
  let source: ComposerPredictionSource | null = null;
  let unsubscribe: (() => void) | null = null;
  let request: AbortController | null = null;
  let pendingRunId: string | null = null;
  let lastRunId: string | null = null;

  function sync() {
    const next = read();
    const scopeChanged = !sameScope(next, source);
    const enabled = next?.enabled && next.eligible;
    if (scopeChanged) {
      lastRunId = null;
    }
    if (scopeChanged || !enabled) {
      unsubscribe?.();
      unsubscribe = null;
      dismiss();
    }
    source = next;
    if (!enabled) {
      return;
    }
    unsubscribe ??= next.gateway.subscribeEvents(handleEvent);
    if (!next.idle) {
      // A final event may arrive just before the idle render; keep that pending anchor,
      // but never retain a displayed or in-flight suggestion across a new run.
      setState((draft) => {
        if (draft.text !== null || request) {
          cancelRequest();
          draft.text = null;
        }
      });
      return;
    }
    if (pendingRunId) {
      const runId = pendingRunId;
      pendingRunId = null;
      void predict(next, runId);
    }
  }

  function cancelRequest() {
    pendingRunId = null;
    request?.abort();
    request = null;
  }

  function dismiss(): string | null {
    cancelRequest();
    let previous: string | null = null;
    // Draft reads see earlier same-turn dismissals before the rendered store commits.
    setState((draft) => {
      previous = draft.text;
      draft.text = null;
    });
    return previous;
  }

  function take(): string | null {
    const current = read();
    const text = dismiss();
    return current?.enabled && current.eligible && current.idle && sameScope(current, source)
      ? text
      : null;
  }

  function acceptInto(target: HTMLTextAreaElement | null) {
    const text = target && !target.value ? take() : null;
    if (!target || !text) {
      return;
    }
    target.focus({ preventScroll: true });
    // Native insertion preserves the browser undo transaction, as with emoji insertion.
    if (!target.ownerDocument.execCommand?.("insertText", false, text)) {
      target.setRangeText(text, 0, 0, "end");
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
    }
  }

  onCleanup(() => {
    unsubscribe?.();
    cancelRequest();
  });

  function sameScope(
    left: ComposerPredictionSource | null,
    right: ComposerPredictionSource | null,
  ) {
    return (
      left?.gateway === right?.gateway &&
      left?.client === right?.client &&
      left?.sessionKey === right?.sessionKey &&
      left?.sessionId === right?.sessionId
    );
  }

  function handleEvent(event: GatewayEventFrame) {
    const current = read();
    const payload = event.payload;
    if (
      !current?.enabled ||
      !current.eligible ||
      !isRecord(payload) ||
      typeof payload.sessionKey !== "string" ||
      !areUiSessionKeysEquivalent(current.sessionKey, payload.sessionKey)
    ) {
      return;
    }
    if (
      event.event === "session.message" &&
      isRecord(payload.message) &&
      payload.message.role === "user"
    ) {
      dismiss();
      return;
    }
    if (event.event !== "chat") {
      return;
    }
    if (payload.state !== "final") {
      dismiss();
      return;
    }
    if (
      typeof payload.runId !== "string" ||
      payload.runId.startsWith("inject-") ||
      payload.runId === lastRunId
    ) {
      return;
    }
    dismiss();
    lastRunId = payload.runId;
    pendingRunId = payload.runId;
    // A final event can precede the composer's idle render. That render calls sync again.
    sync();
  }

  async function predict(origin: ComposerPredictionSource, runId: string) {
    const pending = new AbortController();
    request = pending;
    try {
      const result = await origin.client.request<{ text: string | null }>(
        "chat.predict",
        {
          sessionKey: origin.sessionKey,
          runId,
        },
        { signal: pending.signal },
      );
      const current = read();
      if (
        request !== pending ||
        pending.signal.aborted ||
        !sameScope(origin, current) ||
        !current?.enabled ||
        !current.eligible ||
        !current.idle
      ) {
        return;
      }
      setState((draft) => {
        draft.text = result.text?.trim() || null;
      });
    } catch {
      // Best effort: an unavailable model or cancelled request leaves the ordinary composer intact.
    } finally {
      if (request === pending) {
        request = null;
      }
    }
  }

  return {
    get text() {
      return state.text;
    },
    sync,
    dismiss,
    acceptInto,
  };
}

export type ComposerPrediction = ReturnType<typeof createComposerPrediction>;
