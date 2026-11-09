import type { SkillLibraryFile } from "../../../../packages/gateway-protocol/src/schema/skill-library.js";

export function libraryFileText(file: SkillLibraryFile): string | null {
  if (file.encoding !== "base64") {
    return file.content;
  }
  try {
    const bytes = Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}
