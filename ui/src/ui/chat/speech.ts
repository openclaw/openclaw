/**
 * Browser-native speech services: STT via SpeechRecognition, TTS via SpeechSynthesis.
 * Falls back gracefully when APIs are unavailable.
 */

// ─── STT (Speech-to-Text) ───

type SpeechRecognitionEvent = Event & {
  results: SpeechRecognitionResultList;
  resultIndex: number;
};

type SpeechRecognitionErrorEvent = Event & {
  error: string;
  message?: string;
};

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = globalThis as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

export function isSttSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export type SttCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
};

let activeRecognition: SpeechRecognitionInstance | null = null;

export function startStt(callbacks: SttCallbacks): boolean {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    callbacks.onError?.("Speech recognition is not supported in this browser");
    return false;
  }

  stopStt();

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.addEventListener("start", () => callbacks.onStart?.());

  recognition.addEventListener("result", (event) => {
    const speechEvent = event as unknown as SpeechRecognitionEvent;
    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = speechEvent.resultIndex; i < speechEvent.results.length; i++) {
      const result = speechEvent.results[i];
      if (!result?.[0]) {
        continue;
      }
      const transcript = result[0].transcript;
      if (result.isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    if (finalTranscript) {
      callbacks.onTranscript(finalTranscript, true);
    } else if (interimTranscript) {
      callbacks.onTranscript(interimTranscript, false);
    }
  });

  recognition.addEventListener("error", (event) => {
    const speechEvent = event as unknown as SpeechRecognitionErrorEvent;
    if (speechEvent.error === "aborted" || speechEvent.error === "no-speech") {
      return;
    }
    callbacks.onError?.(speechEvent.error);
  });

  recognition.addEventListener("end", () => {
    if (activeRecognition === recognition) {
      activeRecognition = null;
    }
    callbacks.onEnd?.();
  });

  activeRecognition = recognition;
  recognition.start();
  return true;
}

export function stopStt(): void {
  if (activeRecognition) {
    const r = activeRecognition;
    activeRecognition = null;
    try {
      r.stop();
    } catch {
      // already stopped
    }
  }
}

export function isSttActive(): boolean {
  return activeRecognition !== null;
}

// ─── TTS (Text-to-Speech) ───

export function isTtsSupported(): boolean {
  return "speechSynthesis" in globalThis;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export function speakText(
  text: string,
  opts?: {
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (error: string) => void;
  },
): boolean {
  if (!isTtsSupported()) {
    opts?.onError?.("Speech synthesis is not supported in this browser");
    return false;
  }

  stopTts();

  const cleaned = stripMarkdown(text);
  if (!cleaned.trim()) {
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  utterance.addEventListener("start", () => opts?.onStart?.());
  utterance.addEventListener("end", () => {
    if (currentUtterance === utterance) {
      currentUtterance = null;
    }
    opts?.onEnd?.();
  });
  utterance.addEventListener("error", (e) => {
    if (currentUtterance === utterance) {
      currentUtterance = null;
    }
    if (e.error === "canceled" || e.error === "interrupted") {
      return;
    }
    opts?.onError?.(e.error);
  });

  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
  return true;
}

export function stopTts(): void {
  if (currentUtterance) {
    currentUtterance = null;
  }
  if (isTtsSupported()) {
    speechSynthesis.cancel();
  }
}

export function isTtsSpeaking(): boolean {
  return isTtsSupported() && speechSynthesis.speaking;
}

/** Strip common markdown syntax for cleaner speech output. */
function stripMarkdown(text: string): string {
  return (
    text
      // code blocks
      .replace(/```[\s\S]*?```/g, "")
      // inline code
      .replace(/`[^`]+`/g, "")
      // images
      .replace(/!\[.*?\]\(.*?\)/g, "")
      // links → keep text
      .replace(/\[([^\]]+)\]\(.*?\)/g, "$1")
      // headings
      .replace(/^#{1,6}\s+/gm, "")
      // bold/italic
      .replace(/\*{1,3}(.*?)\*{1,3}/g, "$1")
      .replace(/_{1,3}(.*?)_{1,3}/g, "$1")
      // blockquotes
      .replace(/^>\s?/gm, "")
      // horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // list markers
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      // HTML tags
      .replace(/<[^>]+>/g, "")
      // collapse whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
