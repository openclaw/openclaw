import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    permissions: {
      title: "Grant {permissions}",
      neededOn: "OpenClaw needs access on {node} to continue this action.",
      openApp:
        "Grant access in the OpenClaw Mac app on that device: Settings → This Mac → Permissions. Then tell the agent to try again.",
      ready: "Access is available. You can ask the agent to try again.",
      following: "Then grant the remaining permissions: {permissions}.",
      actions: {
        "not-determined": "Grant {permissions}",
        denied: "Open System Settings",
        "restart-required": "Relaunch OpenClaw",
        "stale-grant": "Open System Settings",
        "disabled-in-openclaw": "Enable {permissions}",
      },
      tryAgain: "Try again",
      retryMessage: "I granted {permissions}, try again.",
      states: {
        "not-determined": "Choose Grant to review the permission request.",
        denied: "Open System Settings to allow access for OpenClaw.",
        "restart-required":
          "If you enabled access in System Settings, relaunch OpenClaw to make it available.",
        "stale-grant":
          "macOS may be using a stale permission grant. Open System Settings to review it.",
        "disabled-in-openclaw": "Choose Enable to review and enable this capability in OpenClaw.",
      },
      capabilities: {
        notifications: "Notifications",
        accessibility: "Accessibility",
        eventPosting: "Event Posting",
        screenRecording: "Screen Recording",
        microphone: "Microphone",
        speechRecognition: "Speech Recognition",
        camera: "Camera",
        cameraEnabled: "Camera in OpenClaw",
        location: "Location",
        computerControl: "Computer Control",
        canvas: "Canvas",
        automation: "Automation",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatPermissionsEnglish = Object.assign(
  () => Object.assign(en.chat.permissions, catalog.chat.permissions),
  { catalog },
);
