const MEDIA_PLACEHOLDER_RE = /^<media:[^>]+>(\s*\([^)]*\))?$/i;
const MEDIA_PLACEHOLDER_TOKEN_RE = /^<media:[^>]+>(\s*\([^)]*\))?\s*/i;
export function extractMediaUserText(body) {
    const trimmed = body?.trim() ?? "";
    if (!trimmed) {
        return undefined;
    }
    if (MEDIA_PLACEHOLDER_RE.test(trimmed)) {
        return undefined;
    }
    const cleaned = trimmed.replace(MEDIA_PLACEHOLDER_TOKEN_RE, "").trim();
    return cleaned || undefined;
}
function formatSection(title, kind, text, userText) {
    const lines = [`[${title}]`];
    if (userText) {
        lines.push(`User text:\n${userText}`);
    }
    lines.push(`${kind}:\n${text}`);
    return lines.join("\n");
}
export function formatMediaUnderstandingBody(params) {
    const outputs = params.outputs.filter((output) => output.text.trim());
    if (outputs.length === 0) {
        return params.body ?? "";
    }
    const userText = extractMediaUserText(params.body);
    const sections = [];
    if (userText && outputs.length > 1) {
        sections.push(`User text:\n${userText}`);
    }
    const counts = new Map();
    for (const output of outputs) {
        counts.set(output.kind, (counts.get(output.kind) ?? 0) + 1);
    }
    const seen = new Map();
    for (const output of outputs) {
        const count = counts.get(output.kind) ?? 1;
        const next = (seen.get(output.kind) ?? 0) + 1;
        seen.set(output.kind, next);
        const suffix = count > 1 ? ` ${next}/${count}` : "";
        if (output.kind === "audio.transcription") {
            sections.push(formatSection(`Audio${suffix}`, "Transcript", output.text, outputs.length === 1 ? userText : undefined));
            continue;
        }
        if (output.kind === "image.description") {
            sections.push(formatSection(`Image${suffix}`, "Description", output.text, outputs.length === 1 ? userText : undefined));
            continue;
        }
        sections.push(formatSection(`Video${suffix}`, "Description", output.text, outputs.length === 1 ? userText : undefined));
    }
    return sections.join("\n\n").trim();
}
export function formatAudioTranscripts(outputs) {
    if (outputs.length === 1) {
        return outputs[0].text;
    }
    return outputs.map((output, index) => `Audio ${index + 1}:\n${output.text}`).join("\n\n");
}
