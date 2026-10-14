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
  private closed = false;
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

  stop(): void {
    this.closed = true;
    const capture = this.capture;
    this.capture = null;
    void capture?.cancel().catch(() => undefined);
    this.options.playback.stop();
    this.chatAbort?.abort();
    if (this.runId) {
      void this.abortRun(this.runId);
      this.runId = undefined;
    }
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
      const text = await capture.finish(true);
      if (this.closed || this.capture !== capture) {
        return;
      }
      this.capture = null;
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
        }
      }
      await this.listen();
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
      signal: controller.signal,
    };
    // A terminal event can precede the admission ACK; subscribe before sending.
    const answer = waitForChatResult(waiting);
    void answer.catch(() => undefined);
    try {
      const ack = await this.options.sendMessage(message, runId);
      if (this.closed) {
        await this.abortRun(ack.runId);
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
    this.stop();
    this.callbacks.onStatus?.("error", formatUiError(error));
  }
}
