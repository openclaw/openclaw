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

/** Applies a moving highlight window to status text. */
function shimmerText(theme: MinimalTheme, text: string, tick: number) {
  const width = 6;
  const hi = (ch: string) => theme.bold(theme.accentSoft(ch));

  const pos = tick % (text.length + width);
  const start = Math.max(0, pos - width);
  const end = Math.min(text.length - 1, pos);

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
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
  const phrases = params.phrases ?? defaultWaitingPhrases;
  const phrase = phrases[Math.floor(params.tick / 10) % phrases.length] ?? phrases[0] ?? "waiting";
  const cute = shimmerText(params.theme, `${phrase}…`, params.tick);
  return `${cute} • ${params.elapsed} | ${params.connectionStatus}`;
}
