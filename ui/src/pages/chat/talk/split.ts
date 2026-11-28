import type { RealtimeVoiceCloseOptions } from "../../../../../src/talk/provider-types.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { GatewaySpeechPlayback } from "../../../lib/speech-playback.ts";
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
    private readonly onReplyCaptureReady?: (echoCancellation: boolean) => void,
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

  hasEchoCancellation(): boolean {
    return this.capture?.hasEchoCancellation() === true;
  }

  private async listen(afterReply = false): Promise<void> {
    if (this.closed) {
      return;
    }
    let cuePending = afterReply;
    const capture = new ComposerDictationSession(
      this.client,
      {
        onReady: () => {
          if (this.closed || this.capture !== capture) {
            return;
          }
          this.callbacks.onStatus?.("listening");
          if (cuePending && !this.closed && this.capture === capture) {
            cuePending = false;
            this.onReplyCaptureReady?.(capture.hasEchoCancellation());
          }
        },
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
      let afterReply = false;
      if (text) {
        const answer = await this.send(text);
        if (this.closed) {
          return;
        }
        if (answer) {
          await this.options.playback.speak(
            this.client,
            answer,
            this.options.speechMethod,
            () => !this.closed,
            this.options.maxTextLength,
          );
          afterReply = true;
        }
      }
      await this.listen(afterReply);
    } catch (error) {
      this.fail(error);
    }
  }

  private async send(message: string): Promise<string> {
    const runId: string = crypto.randomUUID();
    this.runId = runId;
    const controller = new AbortController();
    this.chatAbort = controller;
    const waiting = {
      client: this.client,
      runId,
      timeoutMs: 120_000,
      timeoutMessage: t("chat.voice.replyTimedOut"),
      signal: controller.signal,
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
