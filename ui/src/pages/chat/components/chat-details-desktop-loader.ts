import { lazy } from "solid-js";
import { createIdleImport } from "../../../lib/idle-import.ts";

const environment = createIdleImport(() => import("./chat-details-environment-body.tsx"));
const composition = createIdleImport(() => import("./chat-details-session.tsx"));

export const loadChatDetailsEnvironmentBody = environment.load;
export const ChatDetailsDesktopComposition = lazy(
  async () => {
    // Both imports start on cached admission; only the lazy Details boundary waits.
    const [module] = await Promise.all([composition.load(), environment.load()]);
    return module;
  },
  { export: "ChatDetailsDesktopComposition" },
);
// Warm the renderer's binding too, so loaded code is ready on the first mount.
export const loadChatDetailsDesktopComposition = ChatDetailsDesktopComposition.preload;
