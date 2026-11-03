function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Serialize plain text as a single voice, without interpreting it as SSML. */
export function buildSingleVoiceSsml(params: {
  text: string;
  voice: string;
  lang: string;
}): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xml:lang="${escapeXmlAttr(params.lang)}">` +
    `<voice name="${escapeXmlAttr(params.voice)}">${escapeXmlText(params.text)}</voice>` +
    `</speak>`
  );
}
