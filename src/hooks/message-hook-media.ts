import type { MediaFact } from "../media/media-facts.js";

/** Stable media fact exposed to message-hook consumers. */
export type MessageHookMediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaFact["kind"];
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
};

/** Copies runtime media into the public hook shape without internal staging/hydration flags. */
export function projectMessageHookMediaFacts(
  media: readonly MediaFact[] | null | undefined,
): MessageHookMediaFact[] {
  return (media ?? []).map((fact) => {
    const projected: MessageHookMediaFact = {};
    Object.assign(
      projected,
      fact.path !== undefined ? { path: fact.path } : {},
      fact.url !== undefined ? { url: fact.url } : {},
      fact.contentType !== undefined ? { contentType: fact.contentType } : {},
      fact.kind !== undefined ? { kind: fact.kind } : {},
      fact.transcribed === true ? { transcribed: true } : {},
      fact.messageId !== undefined ? { messageId: fact.messageId } : {},
      fact.workspaceDir !== undefined ? { workspaceDir: fact.workspaceDir } : {},
    );
    return projected;
  });
}
