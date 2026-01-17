import type { MediaUnderstandingOutput } from "./types.js";

const MEDIA_PLACEHOLDER_RE = /^<media:[^>]+>(\s*\([^)]*\))?$/i;
const MEDIA_PLACEHOLDER_TOKEN_RE = /^<media:[^>]+>(\s*\([^)]*\))?\s*/i;

export function extractMediaUserText(body?: string): string | undefined {
  const trimmed = body?.trim() ?? "";
  if (!trimmed) return undefined;
  if (MEDIA_PLACEHOLDER_RE.test(trimmed)) return undefined;
  const cleaned = trimmed.replace(MEDIA_PLACEHOLDER_TOKEN_RE, "").trim();
  return cleaned || undefined;
}

function formatSection(
  title: "Audio" | "Video" | "Image",
  kind: "Transcript" | "Description",
  text: string,
  userText?: string,
): string {
  const lines = [`[${title}]`];
  if (userText) {
    lines.push(`User text:\n${userText}`);
  }
  lines.push(`${kind}:\n${text}`);
  return lines.join("\n");
}

export function formatMediaUnderstandingBody(params: {
  body?: string;
  outputs: MediaUnderstandingOutput[];
}): string {
  const outputs = params.outputs.filter((output) => output.text.trim());
  if (outputs.length === 0) {
    return params.body ?? "";
  }

  const userText = extractMediaUserText(params.body);
  const sections: string[] = [];
  if (userText && outputs.length > 1) {
    sections.push(`User text:\n${userText}`);
  }

  for (const output of outputs) {
    if (output.kind === "audio.transcription") {
      sections.push(
        formatSection(
          "Audio",
          "Transcript",
          output.text,
          outputs.length === 1 ? userText : undefined,
        ),
      );
      continue;
    }
    if (output.kind === "image.description") {
      sections.push(
        formatSection(
          "Image",
          "Description",
          output.text,
          outputs.length === 1 ? userText : undefined,
        ),
      );
      continue;
    }
    sections.push(
      formatSection(
        "Video",
        "Description",
        output.text,
        outputs.length === 1 ? userText : undefined,
      ),
    );
  }

  return sections.join("\n\n").trim();
}
