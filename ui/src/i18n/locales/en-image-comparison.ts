import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    imageLightbox: {
      compareFailed:
        "Could not compare these images. Choose a valid PNG, JPEG, or WebP image and try again.",
      compareTitle: "Compare image: {title}",
      compareHint:
        "Compare same-size images as rendered by this browser. Magenta marks changed pixels after browser color and transparency normalization. Your reference stays local; this is not a source-file equality test.",
      compareChoose: "Choose reference image",
      compareOriginal: "Chat image",
      compareReference: "Local reference",
      compareDifference: "Pixel difference",
      compareDownload: "Download difference PNG",
      compareCount: "{count} of {total} pixels differ ({percent}%)",
      compareDimensions: "Images must have the same pixel dimensions. Choose another reference.",
      compareTooLarge: "Choose images with at most 16 million pixels for comparison.",
    },
  },
} satisfies TranslationMap;

export const registerImageComparisonEnglish = Object.assign(
  () => Object.assign(en.chat.imageLightbox, catalog.chat.imageLightbox),
  { catalog },
);
