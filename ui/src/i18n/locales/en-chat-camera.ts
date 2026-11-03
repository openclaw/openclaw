import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatCamera = {
  chat: {
    camera: {
      title: "Take photo",
      previewHint: "Preview your camera before taking a photo.",
      reviewHint: "Use this photo or retake it. Your camera is off.",
      photoAlt: "Captured photo",
      requesting: "Waiting for your camera. Allow access if prompted.",
      capturing: "Preparing your photo…",
      capture: "Capture",
      retake: "Retake",
      usePhoto: "Use photo",
      upload: "Upload photo",
      retry: "Try again",
      errorTitle: "Camera unavailable",
      previewUnavailable: "Camera preview unavailable",
      useNativeCamera: "Use device camera",
      insecure:
        "Live preview requires HTTPS or localhost. Use your device camera or upload a photo. Your browser may show a camera or file picker.",
      unsupported:
        "This browser can’t show a live camera preview. Use your device camera or upload a photo. Your browser may show a camera or file picker.",
      permissionDenied:
        "Camera access was denied. Allow camera access in your browser and system settings, then try again.",
      notFound: "No camera found. Connect a camera or upload a photo.",
      unavailable:
        "Couldn’t start the camera. Close other apps using it, then try again.",
      stopped: "Your camera stopped. Reconnect it and try again or upload a photo.",
      captureFailed: "Couldn’t take the photo. Try again or upload a photo.",
    },
  },
} satisfies TranslationMap;

export const registerChatCameraEnglish = Object.assign(
  () => Object.assign(en.chat, enChatCamera.chat),
  { catalog: enChatCamera },
);
