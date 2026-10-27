import { ARTIFACT_DOWNLOAD_PATH } from "../../../../packages/gateway-protocol/src/artifact-download.ts";
import type { ControlUiLinkReaderPreview } from "../../../../src/shared/control-ui-link-reader.js";

type ChatImageDisplayFact = {
  width: number;
  height: number;
  rendition: 480 | 960;
  // Browser-local display bytes, never a ticket or an authorization receipt.
  thumbnail?: Blob;
};

export type ChatRowDisplayFacts = {
  links?: Record<string, ChatLinkDisplay>;
  images?: Record<string, ChatImageDisplayFact>;
};

export type ChatRowDisplay = {
  read: () => { scope: string; facts: ChatRowDisplayFacts | undefined } | undefined;
  write: (update: Partial<ChatRowDisplayFacts>) => void;
};

export type ChatDisplayFacts = {
  forRow: (messageId: string | null) => ChatRowDisplay | undefined;
};

/** Retain source identity, never signed transport URLs or embedded credentials. */
export function chatDisplaySourceKey(source: string): string | undefined {
  if (source.length > 2048 || /^(?:data|blob):/u.test(source)) {
    return undefined;
  }
  try {
    const url = new URL(source, globalThis.location.origin);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.pathname.includes(ARTIFACT_DOWNLOAD_PATH) ||
      [...url.searchParams.keys()].some((key) => key !== "v")
    ) {
      return undefined;
    }
    return source;
  } catch {
    return undefined;
  }
}

export function chatImageDisplayKey(
  image: { url?: string; artifactId?: string },
  rendition: 480 | 960,
): string | undefined {
  const source = image.url && chatDisplaySourceKey(image.url);
  return image.url && !source
    ? undefined
    : JSON.stringify([image.artifactId ?? null, source ?? null, rendition]);
}
export type ChatLinkDisplay = {
  title?: string;
  badge?: Pick<NonNullable<ControlUiLinkReaderPreview["badge"]>, "label" | "tone">;
};

export const MAX_CHAT_THUMBNAILS = 32;
export const MAX_CHAT_THUMBNAIL_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_THUMBNAIL_SIZE = 256 * 1024;
