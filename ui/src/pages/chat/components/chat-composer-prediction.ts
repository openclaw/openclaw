import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
export class ComposerPredictionController {
  text: string | null = null;
  private source: ComposerPredictionSource | null = null;
  private unsubscribe: (() => void) | null = null;
  private request: AbortController | null = null;
  private pendingRunId: string | null = null;
  private lastRunId: string | null = null;

  constructor(
    private readonly read: () => ComposerPredictionSource | null,
    private readonly notify: () => void,
  ) {}

  sync() {
    const next = this.read();
    if (!this.sameScope(next, this.source)) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.dismiss();
      this.lastRunId = null;
      this.source = next;
    } else {
      this.source = next;
    }
    if (!next?.enabled || !next.eligible) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.dismiss();
      return;
    }
    this.unsubscribe ??= next.gateway.subscribeEvents((event) => this.handleEvent(event));
    if (!next.idle) {
      // A final event may arrive just before the idle render; keep that pending anchor,
      // but never retain a displayed or in-flight suggestion across a new run.
      if (this.text !== null || this.request) {
        this.dismiss();
      }
      return;
    }
    if (this.pendingRunId) {
      const runId = this.pendingRunId;
      this.pendingRunId = null;
      void this.predict(next, runId);
    }
  }

  dismiss() {
    this.pendingRunId = null;
    this.request?.abort();
    this.request = null;
    if (this.text !== null) {
      this.text = null;
      this.notify();
    }
  }

  take(): string | null {
    const current = this.read();
    const text =
      current?.enabled && current.eligible && current.idle && this.sameScope(current, this.source)
        ? this.text
        : null;
    this.dismiss();
    return text;
  }

  acceptInto(target: HTMLTextAreaElement | null) {
    if (!target || target.value) {
      return;
    }
    const text = this.take();
    if (!text) {
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

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.request?.abort();
    this.request = null;
    this.pendingRunId = null;
    this.text = null;
    this.source = null;
  }

  private sameScope(left: ComposerPredictionSource | null, right: ComposerPredictionSource | null) {
    return (
      left?.gateway === right?.gateway &&
      left?.client === right?.client &&
      left?.sessionKey === right?.sessionKey &&
      left?.sessionId === right?.sessionId
    );
  }

  private handleEvent(event: GatewayEventFrame) {
    const source = this.read();
    const payload = event.payload;
    if (
      !source?.enabled ||
      !source.eligible ||
      !isRecord(payload) ||
      typeof payload.sessionKey !== "string" ||
      !areUiSessionKeysEquivalent(source.sessionKey, payload.sessionKey)
    ) {
      return;
    }
    if (
      event.event === "session.message" &&
      isRecord(payload.message) &&
      payload.message.role === "user"
    ) {
      this.dismiss();
      return;
    }
    if (event.event !== "chat") {
      return;
    }
    if (payload.state !== "final") {
      this.dismiss();
      return;
    }
    if (
      typeof payload.runId !== "string" ||
      payload.runId.startsWith("inject-") ||
      payload.runId === this.lastRunId
    ) {
      return;
    }
    this.dismiss();
    this.lastRunId = payload.runId;
    this.pendingRunId = payload.runId;
    // A final event can precede the composer's idle render. That render calls sync again.
    this.sync();
  }

  private async predict(source: ComposerPredictionSource, runId: string) {
    const request = new AbortController();
    this.request = request;
    try {
      const result = await source.client.request<{ text: string | null }>(
        "chat.predict",
        {
          sessionKey: source.sessionKey,
          runId,
        },
        { signal: request.signal },
      );
      const current = this.read();
      if (
        this.request !== request ||
        request.signal.aborted ||
        !this.sameScope(source, current) ||
        !current?.enabled ||
        !current.eligible ||
        !current.idle
      ) {
        return;
      }
      this.text = result.text?.trim() || null;
      if (this.text) {
        this.notify();
      }
    } catch {
      // Best effort: an unavailable model or cancelled request leaves the ordinary composer intact.
    } finally {
      if (this.request === request) {
        this.request = null;
      }
    }
  }
}
