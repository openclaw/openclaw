import { generateUUID } from "../uuid.ts";
import {
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  waitForChatResult,
} from "./realtime-talk-shared.ts";

type SpeechRecognitionAlternative = {
  readonly transcript?: string;
};

type SpeechRecognitionResult = {
  readonly isFinal?: boolean;
  readonly 0?: SpeechRecognitionAlternative;
};

type SpeechRecognitionResultList = {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult | undefined;
};

type SpeechRecognitionEventLike = {
  readonly resultIndex?: number;
  readonly results?: SpeechRecognitionResultList;
};

type SpeechRecognitionErrorEventLike = {
  readonly error?: string;
  readonly message?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort?: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type BrowserSpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

type TalkSpeakResult = {
  audioBase64?: string;
  mimeType?: string;
};

const FALLBACK_ERROR_PATTERNS = [
  /Realtime voice provider ".+" is not configured/i,
  /No realtime voice provider registered/i,
  /OpenAI API key missing/i,
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shouldUseBrowserFallbackForRealtimeError(error: unknown): boolean {
  const message = errorMessage(error);
  return FALLBACK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const speechWindow = window as BrowserSpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function getBrowserSpeechLanguage(): string {
  const nav = typeof navigator === "undefined" ? null : navigator;
  return nav?.language?.trim() || "nl-NL";
}

function buildAudioDataUrl(result: TalkSpeakResult): string | null {
  if (!result.audioBase64) {
    return null;
  }
  return `data:${result.mimeType || "audio/mpeg"};base64,${result.audioBase64}`;
}

export class BrowserFallbackRealtimeTalkTransport implements RealtimeTalkTransport {
  private recognition: SpeechRecognitionLike | null = null;
  private closed = false;
  private processing = false;
  private restartTimer: number | null = null;
  private currentAudio: HTMLAudioElement | null = null;

  constructor(private readonly ctx: RealtimeTalkTransportContext) {}

  async start(): Promise<void> {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      throw new Error(
        "Talk needs either a configured realtime voice provider or browser speech recognition support.",
      );
    }
    this.closed = false;
    this.recognition = new Recognition();
    this.recognition.lang = getBrowserSpeechLanguage();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.onstart = () => {
      if (!this.closed && !this.processing) {
        this.ctx.callbacks.onStatus?.("listening", "Listening with browser dictation");
      }
    };
    this.recognition.onend = () => {
      if (!this.closed && !this.processing) {
        this.scheduleRecognitionRestart();
      }
    };
    this.recognition.onerror = (event) => {
      if (this.closed) {
        return;
      }
      const code = event.error?.trim();
      if (code === "no-speech" || code === "aborted") {
        this.ctx.callbacks.onStatus?.("listening", "Listening with browser dictation");
        return;
      }
      this.ctx.callbacks.onStatus?.(
        "error",
        event.message?.trim() || code || "Browser speech recognition failed",
      );
    };
    this.recognition.onresult = (event) => {
      this.handleRecognitionResult(event);
    };
    this.startRecognition();
  }

  stop(): void {
    this.closed = true;
    if (this.restartTimer != null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.currentAudio?.pause();
    this.currentAudio = null;
    this.recognition?.abort?.();
    this.recognition?.stop();
    this.recognition = null;
    this.ctx.callbacks.onStatus?.("idle");
  }

  private startRecognition(): void {
    if (this.closed || this.processing || !this.recognition) {
      return;
    }
    try {
      this.recognition.start();
      this.ctx.callbacks.onStatus?.("listening", "Listening with browser dictation");
    } catch (error) {
      const message = errorMessage(error);
      if (!/already started|recognition has already started/i.test(message)) {
        this.ctx.callbacks.onStatus?.("error", message);
      }
    }
  }

  private scheduleRecognitionRestart(): void {
    if (this.restartTimer != null) {
      window.clearTimeout(this.restartTimer);
    }
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      this.startRecognition();
    }, 250);
  }

  private handleRecognitionResult(event: SpeechRecognitionEventLike): void {
    const results = event.results;
    if (!results) {
      return;
    }
    let finalText = "";
    let interimText = "";
    const start = Math.max(0, event.resultIndex ?? 0);
    for (let index = start; index < results.length; index += 1) {
      const result = results[index];
      const transcript = result?.[0]?.transcript?.trim();
      if (!transcript) {
        continue;
      }
      if (result?.isFinal) {
        finalText = `${finalText} ${transcript}`.trim();
      } else {
        interimText = `${interimText} ${transcript}`.trim();
      }
    }
    if (interimText) {
      this.ctx.callbacks.onTranscript?.({ role: "user", text: interimText, final: false });
    }
    if (finalText) {
      void this.processUtterance(finalText);
    }
  }

  private async processUtterance(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.closed || this.processing) {
      return;
    }
    this.processing = true;
    this.recognition?.stop();
    this.ctx.callbacks.onTranscript?.({ role: "user", text: trimmed, final: true });
    try {
      this.ctx.callbacks.onStatus?.("thinking", "Asking Thomas...");
      const idempotencyKey = generateUUID();
      const response = await this.ctx.client.request<{ runId?: string }>("chat.send", {
        sessionKey: this.ctx.sessionKey,
        message: trimmed,
        idempotencyKey,
      });
      const reply = await waitForChatResult({
        client: this.ctx.client,
        runId: response.runId ?? idempotencyKey,
        timeoutMs: 120_000,
      });
      if (this.closed) {
        return;
      }
      this.ctx.callbacks.onTranscript?.({ role: "assistant", text: reply, final: true });
      await this.speak(reply);
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("listening", "Listening with browser dictation");
      }
    } catch (error) {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", errorMessage(error));
      }
    } finally {
      this.processing = false;
      if (!this.closed) {
        this.scheduleRecognitionRestart();
      }
    }
  }

  private async speak(text: string): Promise<void> {
    const result = await this.ctx.client.request<TalkSpeakResult>("talk.speak", { text });
    const dataUrl = buildAudioDataUrl(result);
    if (!dataUrl) {
      return;
    }
    const audio = new Audio(dataUrl);
    this.currentAudio = audio;
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      const playResult = audio.play();
      if (playResult && typeof playResult.then === "function") {
        playResult.catch(() => resolve());
      }
    });
    if (this.currentAudio === audio) {
      this.currentAudio = null;
    }
  }
}
