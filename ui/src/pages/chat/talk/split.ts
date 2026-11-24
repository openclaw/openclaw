import type { RealtimeVoiceCloseOptions } from "../../../../../src/talk/provider-types.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { GatewaySpeechPlayback, SpeechSegment } from "../../../lib/speech-playback.ts";
import { isTerminalFailureChatSendAck, type ChatSendAck } from "../chat-send-ack.ts";
import { ComposerDictationSession } from "../composer-dictation-session.ts";
import {
  waitForChatResult,
  type RealtimeTalkCallbacks,
  type RealtimeTalkTransport,
} from "./shared.ts";

export type SplitTalkOptions = {
  silenceTimeoutMs: number;
  speechMethod: "talk.speak" | "tts.speak";
  sendMessage: (message: string, runId: string) => Promise<ChatSendAck>;
  playback: GatewaySpeechPlayback;
  maxTextLength?: number;
};

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const fenceOpen = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;

/**
 * Sentence segments of a Markdown reply. A fenced code block stays one segment,
 * so the speech endpoint still sees the whole block and can apply its code-heavy fallback.
 */
function* segmentReply(text: string): Generator<{ index: number; segment: string }> {
  let pos = 0;
  while (pos < text.length) {
    fenceOpen.lastIndex = pos;
    const open = fenceOpen.exec(text);
    const end = open ? open.index : text.length;
    for (const part of sentenceSegmenter.segment(text.slice(pos, end))) {
      yield { index: pos + part.index, segment: part.segment };
    }
    if (!open) {
      return;
    }
    const marker = open[1] ?? "```";
    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, "m");
    const bodyStart = open.index + open[0].length;
    const found = close.exec(text.slice(bodyStart));
    // An unclosed fence runs to the end; the caller holds it back until the final reply.
    const stop = found ? bodyStart + found.index + found[0].length : text.length;
    yield { index: open.index, segment: text.slice(open.index, stop) };
    pos = stop;
  }
}

/** Split Talk uses the same capture, chat, and speech owners as the composer. */
export class SplitTalkTransport implements RealtimeTalkTransport {
  private capture: ComposerDictationSession | null = null;
  private closed: RealtimeVoiceCloseOptions["disposition"];
  private runId: string | undefined;
  private chatAbort: AbortController | undefined;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks,
    private readonly options: SplitTalkOptions,
    private readonly inputDeviceId?: string,
  ) {}

  async start(): Promise<"ready" | "cancelled"> {
    this.callbacks.onVideoCapability?.(false);
    await this.listen();
    return this.closed ? "cancelled" : "ready";
  }

  stop({ disposition = "abort" }: RealtimeVoiceCloseOptions = {}): void {
    if (this.closed) {
      return;
    }
    this.closed = disposition;
    const capture = this.capture;
    this.capture = null;
    void capture?.cancel().catch(() => undefined);
    this.options.playback.stop();
    this.chatAbort?.abort();
    if (this.runId && disposition === "abort") {
      void this.abortRun(this.runId);
    }
    this.runId = undefined;
    this.callbacks.onInputLevel?.(0);
  }

  private async listen(): Promise<void> {
    if (this.closed) {
      return;
    }
    const capture = new ComposerDictationSession(
      this.client,
      {
        onReady: () => this.callbacks.onStatus?.("listening"),
        onError: (message) => this.fail(new Error(message)),
        onLevel: (level) => this.callbacks.onInputLevel?.(level),
        onTranscriptChange: () => undefined,
        onSilence: () => void this.completeTurn(capture),
      },
      {
        sessionKey: this.sessionKey,
        inputDeviceId: this.inputDeviceId,
        silenceTimeoutMs: this.options.silenceTimeoutMs,
      },
    );
    this.capture = capture;
    await capture.start();
  }

  private async completeTurn(capture: ComposerDictationSession): Promise<void> {
    if (this.closed || this.capture !== capture) {
      return;
    }
    this.callbacks.onStatus?.("thinking");
    try {
      const text = await capture.finish();
      if (this.closed || this.capture !== capture) {
        return;
      }
      this.capture = null;
      if (text) {
        await this.speakReply(text);
      }
      await this.listen();
    } catch (error) {
      this.fail(error);
    }
  }

  private async speakReply(message: string): Promise<void> {
    let output!: ReadableStreamDefaultController<string>;
    const sentences = new ReadableStream<SpeechSegment>({
      start(controller) {
        output = controller;
      },
    });
    let prefix = "";
    const queued: Array<{ end: number; withdraw: AbortController }> = [];
    const enqueue = (text: string, final: boolean) => {
      if (this.closed) {
        return;
      }
      if (!text.startsWith(prefix)) {
        if (!final) {
          return; // Wait for the authoritative reply after a rewrite.
        }
        // Keep only the complete sentences that still agree with the final reply.
        let unchanged = 0;
        for (const { index, segment } of segmentReply(text)) {
          if (prefix.slice(index, index + segment.length) !== segment) {
            break;
          }
          unchanged = index + segment.length;
        }
        // Withdraw queued or prefetched speech the final reply no longer contains.
        for (const item of queued) {
          if (item.end > unchanged) {
            item.withdraw.abort();
          }
        }
        prefix = text.slice(0, unchanged);
      }
      const remainder = text.slice(prefix.length);
      for (const { index, segment } of segmentReply(remainder)) {
        if (!final && index + segment.length === remainder.length) {
          break; // The next snapshot can still extend the trailing segment.
        }
        prefix += segment;
        if (segment.trim()) {
          const withdraw = new AbortController();
          queued.push({ end: prefix.length, withdraw });
          output.enqueue({ text: segment.trim(), signal: withdraw.signal });
        }
      }
    };
    const reply = this.send(message, (text) => enqueue(text, false)).then((answer) => {
      enqueue(answer, true);
      output.close();
    });
    await Promise.all([
      reply,
      this.options.playback.speak(
        this.client,
        sentences,
        this.options.speechMethod,
        () => !this.closed,
        this.options.maxTextLength,
      ),
    ]);
  }

  private async send(message: string, onDelta: (text: string) => void): Promise<string> {
    const runId: string = crypto.randomUUID();
    this.runId = runId;
    const controller = new AbortController();
    this.chatAbort = controller;
    let admitted = false;
    let earlyDelta = "";
    const waiting = {
      client: this.client,
      runId,
      timeoutMs: 120_000,
      timeoutMessage: t("chat.voice.replyTimedOut"),
      signal: controller.signal,
      onDelta: (text: string) => {
        if (admitted) {
          onDelta(text);
        } else {
          earlyDelta = text;
        }
      },
    };
    // A terminal event can precede the admission ACK; subscribe before sending.
    const answer = waitForChatResult(waiting);
    void answer.catch(() => undefined);
    try {
      const ack = await this.options.sendMessage(message, runId);
      if (this.closed) {
        if (this.closed === "abort") {
          await this.abortRun(ack.runId);
        }
        return "";
      }
      if (isTerminalFailureChatSendAck(ack)) {
        throw new Error(t("chat.voice.replyFailed"));
      }
      waiting.runId = ack.runId;
      this.runId = ack.runId;
      admitted = true;
      if (ack.runId === runId && earlyDelta) {
        onDelta(earlyDelta);
      }
      const result = await answer;
      this.runId = undefined;
      return result;
    } finally {
      controller.abort();
      if (this.chatAbort === controller) {
        this.chatAbort = undefined;
      }
    }
  }

  private async abortRun(runId: string): Promise<void> {
    await this.client
      .request("chat.abort", { sessionKey: this.sessionKey, runId })
      .catch(() => undefined);
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    // Status callbacks can synchronously stop Talk; commit detachment first.
    this.stop({ disposition: "detach" });
    this.callbacks.onStatus?.("error", formatUiError(error));
  }
}
