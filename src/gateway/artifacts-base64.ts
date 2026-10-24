export type ArtifactBase64Payload = {
  data?: string;
  sizeBytes: number;
};

export function mimeFromDataUrl(value: string): string | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

export function base64FromDataUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0 || trimmed.slice(0, 5).toLowerCase() !== "data:") {
    return undefined;
  }
  const metadata = trimmed.slice(0, commaIndex).toLowerCase();
  if (!metadata.includes(";base64")) {
    return undefined;
  }
  return trimmed.slice(commaIndex + 1);
}

function normalizeArtifactBase64Alphabet(value: string): string {
  if (!/[-_]/.test(value)) {
    return value;
  }
  // A byte buffer avoids per-character string allocations for large URL-safe payloads.
  const bytes = Buffer.from(value, "ascii");
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x2d) {
      bytes[index] = 0x2b;
    } else if (bytes[index] === 0x5f) {
      bytes[index] = 0x2f;
    }
  }
  return bytes.toString("ascii");
}

export function readArtifactBase64Payload(
  value: string | undefined,
  opts: { includeData: boolean },
): ArtifactBase64Payload | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/[^A-Za-z0-9+/_= \n\r\t-]/.test(value)) {
    return undefined;
  }
  const paddingStart = value.indexOf("=");
  if (paddingStart >= 0 && !/^(?:=[ \n\r\t]*){1,2}$/.test(value.slice(paddingStart))) {
    return undefined;
  }
  const padding = paddingStart < 0 ? 0 : value.lastIndexOf("=") === paddingStart ? 1 : 2;
  const hasWhitespace = /[ \n\r\t]/.test(value);
  let encodedLength = value.length;
  if (hasWhitespace) {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
        encodedLength -= 1;
      }
    }
  }
  const remainder = encodedLength % 4;
  if ((padding > 0 && remainder !== 0) || remainder === 1) {
    return undefined;
  }
  let data = opts.includeData
    ? normalizeArtifactBase64Alphabet(hasWhitespace ? value.replace(/[ \n\r\t]/g, "") : value)
    : undefined;
  if (data !== undefined && padding === 0 && remainder > 0) {
    data += "=".repeat(4 - remainder);
  }
  return {
    ...(data !== undefined ? { data } : {}),
    sizeBytes: Math.max(0, Math.floor((encodedLength * 3) / 4) - padding),
  };
}
