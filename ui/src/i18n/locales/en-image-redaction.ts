import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    attachments: {
      redactionHint:
        "Drag over areas to cover with opaque black pixels. Applying creates a PNG copy; your original file is unchanged. Review the entire image before sending.",
      redactionCanvas: "Image redaction canvas. Drag to cover an area.",
      redactionCount: "Covered areas: {count}",
      redactionUndo: "Undo last area",
      redactionApply: "Apply redaction",
      redactionTooLarge: "Choose an image with at most 16 million pixels for redaction.",
    },
  },
} satisfies TranslationMap;

export const registerImageRedactionEnglish = Object.assign(
  () => Object.assign(en.chat.attachments, catalog.chat.attachments),
  { catalog },
);
