import { lazy } from "solid-js";

export const ChatDetailsDesktopComposition = lazy(
  async () => {
    const module = await import("./chat-details-session.tsx");
    // Cached sections can render while the independent Environment body warms.
    void module.preloadChatDetailsEnvironment().catch(() => undefined);
    return module;
  },
  { export: "ChatDetailsDesktopComposition" },
);
