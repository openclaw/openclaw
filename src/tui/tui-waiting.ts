type MinimalTheme = {
  dim: (s: string) => string;
  bold: (s: string) => string;
  accentSoft: (s: string) => string;
};

export const ollamaLoadingPhrases = [
  "loading model into memory",
  "warming up the model",
  "preparing weights",
];

export const defaultWaitingPhrases = [
  "photosynthesizing",
  "germinating",
  "composting",
  "cross-pollinating",
  "putting down roots",
  "unfurling leaves",
  "reaching for light",
  "branching out",
  "budding",
  "propagating",
];

export function pickWaitingPhrase(tick: number, phrases = defaultWaitingPhrases) {
  const idx = Math.floor(tick / 10) % phrases.length;
  return phrases[idx] ?? phrases[0] ?? "waiting";
}

export function shimmerText(theme: MinimalTheme, text: string, tick: number) {
  const width = 6;
  const hi = (ch: string) => theme.bold(theme.accentSoft(ch));

  const pos = tick % (text.length + width);
  const start = Math.max(0, pos - width);
  const end = Math.min(text.length - 1, pos);

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += i >= start && i <= end ? hi(ch) : theme.dim(ch);
  }
  return out;
}

export type OllamaStatus = {
  stage?: "loading" | "generating" | "idle";
  tokPerSec?: number;
};

export function buildWaitingStatusMessage(params: {
  theme: MinimalTheme;
  tick: number;
  elapsed: string;
  connectionStatus: string;
  phrases?: string[];
  ollamaStatus?: OllamaStatus;
}) {
  const { ollamaStatus } = params;
  let phrase: string;
  if (ollamaStatus?.stage === "loading") {
    phrase = pickWaitingPhrase(params.tick, ollamaLoadingPhrases);
  } else {
    phrase = pickWaitingPhrase(params.tick, params.phrases);
  }

  const cute = shimmerText(params.theme, `${phrase}…`, params.tick);
  let extra = "";
  if (ollamaStatus?.stage === "generating" && ollamaStatus.tokPerSec) {
    extra = ` • ${ollamaStatus.tokPerSec.toFixed(1)} tok/s`;
  }
  return `${cute} • ${params.elapsed}${extra} | ${params.connectionStatus}`;
}
