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
export function pickWaitingPhrase(tick, phrases = defaultWaitingPhrases) {
    const idx = Math.floor(tick / 10) % phrases.length;
    return phrases[idx] ?? phrases[0] ?? "waiting";
}
export function shimmerText(theme, text, tick) {
    const width = 6;
    const hi = (ch) => theme.bold(theme.accentSoft(ch));
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
export function buildWaitingStatusMessage(params) {
    const phrase = pickWaitingPhrase(params.tick, params.phrases);
    const cute = shimmerText(params.theme, `${phrase}…`, params.tick);
    return `${cute} • ${params.elapsed} | ${params.connectionStatus}`;
}
