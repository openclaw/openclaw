type MinimalTheme = {
  dim: (s: string) => string;
  bold: (s: string) => string;
  accentSoft: (s: string) => string;
};

export const defaultWaitingPhrases = [
  "flibbertigibbeting",
  "kerfuffling",
  "dillydallying",
  "twiddling thumbs",
  "noodling",
  "bamboozling",
  "moseying",
  "hobnobbing",
  "pondering",
  "conjuring",
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

export function buildWaitingStatusMessage(params: {
  theme: MinimalTheme;
  tick: number;
  elapsed: string;
  connectionStatus: string;
  phrases?: string[];
}) {
  const phrase = pickWaitingPhrase(params.tick, params.phrases);
  const cute = shimmerText(params.theme, `${phrase}…`, params.tick);
  return `${cute} • ${params.elapsed} | ${params.connectionStatus}`;
}
