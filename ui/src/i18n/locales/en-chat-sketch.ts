import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    composer: {
      drawSketch: "Draw a sketch",
      sketchFailed:
        "Could not create the sketch. Your message is unchanged. Reopen Draw a sketch to try again.",
      sketchHint:
        "Draw with a pointer or touch, then attach the PNG to your message. Nothing is sent until you send the message.",
      sketchCanvas: "Blank sketch canvas. Draw with a pointer or touch.",
      sketchUndo: "Undo stroke",
      sketchClear: "Clear sketch",
      sketchAttach: "Attach sketch",
      sketchCount: "Strokes: {count}",
    },
  },
} satisfies TranslationMap;

export const registerChatSketchEnglish = Object.assign(
  () => {
    Object.assign(en.chat.composer, catalog.chat.composer);
  },
  { catalog },
);
