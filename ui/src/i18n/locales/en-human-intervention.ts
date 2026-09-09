import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  humanBrowser: {
    title: "Browser action needed",
    loading: "Loading browser handoff…",
    retry: "Try again",
    unavailable: "Human browser handoff is unavailable on this Gateway.",
    expired: "This browser handoff has expired.",
    cancelled: "This browser handoff was cancelled.",
    resumePending: "Your task is waiting to be queued. The agent has not resumed yet.",
    continuationQueued: "Your task is queued to continue. You can return to your chat.",
    waiting: "The agent is paused while it waits for you.",
    control: "You have control of this browser tab.",
    controlElsewhere: "This handoff is open on another device.",
    takeControl: "Take control",
    done: "Done — continue agent",
    leave: "Leave paused",
    cancel: "Cancel handoff",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    scrollUp: "Scroll up",
    scrollDown: "Scroll down",
    typePlaceholder: "Type into the focused field",
    sendText: "Send text",
    pressEnter: "Press Enter",
    browserLoading: "Connecting to the browser tab…",
  },
} satisfies TranslationMap;

export const registerHumanInterventionEnglish = Object.assign(() => Object.assign(en, catalog), {
  catalog,
});
