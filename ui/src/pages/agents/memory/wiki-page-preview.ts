import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { t } from "../../../i18n/index.ts";
import type { WikiPagePreview } from "./dreaming.ts";

/**
 * Normalizes a `wiki.get` reply into the Dreams wiki preview.
 * @param response Raw `wiki.get` payload.
 * @param lookup Requested page, used when the reply carries no title or path.
 * @returns The preview shown in the wiki panel.
 */
export function wikiPagePreviewFromResponse(response: unknown, lookup: string): WikiPagePreview {
  const payload = asOptionalObjectRecord(response);
  const content =
    typeof payload?.content === "string" && payload.content.length > 0
      ? payload.content
      : t("dreaming.wiki.noContent");
  const updatedAt = normalizeOptionalString(payload?.updatedAt);
  const totalLines =
    typeof payload?.totalLines === "number" && Number.isFinite(payload.totalLines)
      ? Math.max(0, Math.floor(payload.totalLines))
      : undefined;
  return {
    title: normalizeOptionalString(payload?.title) ?? lookup,
    path: normalizeOptionalString(payload?.path) ?? lookup,
    content,
    ...(totalLines === undefined ? {} : { totalLines }),
    ...(payload?.truncated === true ? { truncated: true } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}
